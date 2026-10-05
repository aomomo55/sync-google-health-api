import { describe, expect, it } from "vitest";
import { DailySummarySchema } from "../src/domain/daily.js";
import { buildDays } from "../src/takeout/index.js";
import {
  buildNutritionByDate,
  type NutritionItem,
  nutritionSourceFromFilename,
  parseNutritionJson,
} from "../src/takeout/nutrition.js";

const point = (iso: string, entries: Record<string, number>) => ({
  startTimeNanos: String(Date.parse(iso) * 1_000_000),
  endTimeNanos: String(Date.parse(iso) * 1_000_000),
  dataTypeName: "com.google.nutrition",
  fitValue: [
    {
      value: { mapVal: Object.entries(entries).map(([key, v]) => ({ key, value: { fpVal: v } })) },
    },
    { value: {} },
    { value: {} },
  ],
});

const item = (source: string, iso: string, v: Partial<NutritionItem> = {}): NutritionItem => ({
  source,
  time: Date.parse(iso),
  ...v,
});

describe("nutritionSourceFromFilename", () => {
  it("raw のみ対象で、derived は無視", () => {
    expect(nutritionSourceFromFilename("raw_com.google.nutrition_app.a.json")).toBe("app.a");
    expect(nutritionSourceFromFilename("derived_com.google.nutrition_app.a.json")).toBeUndefined();
    expect(nutritionSourceFromFilename("raw_com.google.sleep.segment_app.a.json")).toBeUndefined();
  });
});

describe("parseNutritionJson", () => {
  it("mapVal から kcal・P・F・C を読み、他のキーは無視する", () => {
    const json = {
      "Data Points": [
        point("2026-03-10T12:00:00+09:00", {
          calories: 500.5,
          protein: 20,
          "fat.total": 10.25,
          "carbs.total": 60,
          sodium: 1,
          "fat.saturated": 3,
        }),
      ],
    };
    expect(parseNutritionJson(json, "app.a")).toEqual([
      {
        source: "app.a",
        time: Date.parse("2026-03-10T12:00:00+09:00"),
        energy: 500.5,
        protein: 20,
        fat: 10.25,
        carbs: 60,
      },
    ]);
  });

  it("キーが欠けた項目は付けず、対象キーが全く無いポイントや不正な形は捨てる", () => {
    const json = {
      "Data Points": [
        point("2026-03-10T12:00:00+09:00", { calories: 300 }),
        point("2026-03-10T13:00:00+09:00", { sodium: 5 }),
        { startTimeNanos: "x", fitValue: [] },
        { startTimeNanos: "1", fitValue: [{ value: { intVal: 1 } }] },
      ],
    };
    const r = parseNutritionJson(json, "app.a");
    expect(r).toHaveLength(1);
    expect(r[0]).toEqual({
      source: "app.a",
      time: Date.parse("2026-03-10T12:00:00+09:00"),
      energy: 300,
    });
    expect(parseNutritionJson(null, "a")).toEqual([]);
    expect(parseNutritionJson({ "Data Points": "x" }, "a")).toEqual([]);
  });

  it("時刻が 2000〜2100 年の範囲外の記録は捨てて数え、日付の計算で例外を出さない", () => {
    const at = (nanos: string) => ({
      ...point("2026-03-10T12:00:00+09:00", { calories: 1 }),
      startTimeNanos: nanos,
    });
    const json = {
      "Data Points": [
        point("2026-03-10T12:00:00+09:00", { calories: 300 }),
        at("1e30"),
        at(String(Date.UTC(1990, 0, 1) * 1e6)),
        at(String(Date.UTC(2100, 0, 2) * 1e6)),
      ],
    };
    const stats = { invalidTime: 0 };
    const items = parseNutritionJson(json, "app.a", stats);
    expect(items).toHaveLength(1);
    expect(stats.invalidTime).toBe(3);
    expect(() => buildNutritionByDate(items)).not.toThrow();
  });
});

describe("buildNutritionByDate", () => {
  it("JST の暦日ごとに合計し、日跨ぎ（23:59 と 00:00）を別の日にする。丸めも行う", () => {
    const r = buildNutritionByDate([
      item("a", "2026-03-10T08:00:00+09:00", { energy: 400.4, protein: 10.04, fat: 5, carbs: 50 }),
      item("a", "2026-03-10T23:59:00+09:00", { energy: 600.4, protein: 20.03, fat: 5.04 }),
      item("a", "2026-03-11T00:00:00+09:00", { energy: 100 }),
      // UTC 表記でも JST の日付で数える（= 3/11 07:00 JST）
      item("a", "2026-03-10T22:00:00Z", { energy: 50 }),
    ]);
    expect([...r.keys()].sort()).toEqual(["2026-03-10", "2026-03-11"]);
    expect(r.get("2026-03-10")?.nutrition).toEqual({
      energy_kcal: 1001, // 1000.8
      protein_g: 30.1, // 30.07
      fat_g: 10, // 10.04
      carbs_g: 50,
    });
    expect(r.get("2026-03-11")?.nutrition).toEqual({ energy_kcal: 150 });
  });

  it("値の無い項目は出力しない", () => {
    const r = buildNutritionByDate([item("a", "2026-03-10T12:00:00+09:00", { protein: 12 })]);
    expect(r.get("2026-03-10")?.nutrition).toEqual({ protein_g: 12 });
  });

  it("複数ソースは、その日の記録件数が多いソースだけを使う（合算しない）", () => {
    const r = buildNutritionByDate([
      item("a", "2026-03-10T08:00:00+09:00", { energy: 5000 }),
      item("b", "2026-03-10T08:00:00+09:00", { energy: 300 }),
      item("b", "2026-03-10T12:00:00+09:00", { energy: 400 }),
      // 別の日は a だけ
      item("a", "2026-03-11T08:00:00+09:00", { energy: 700 }),
    ]);
    expect(r.get("2026-03-10")).toMatchObject({ source: "b", entries: 2 });
    expect(r.get("2026-03-10")?.nutrition.energy_kcal).toBe(700);
    expect(r.get("2026-03-11")?.source).toBe("a");
  });

  it("件数が同じなら合計 kcal が大きいもの、それも同じなら source id の辞書順", () => {
    const r1 = buildNutritionByDate([
      item("a", "2026-03-10T08:00:00+09:00", { energy: 100 }),
      item("b", "2026-03-10T08:00:00+09:00", { energy: 200 }),
    ]);
    expect(r1.get("2026-03-10")?.source).toBe("b");
    const r2 = buildNutritionByDate([
      item("b", "2026-03-10T08:00:00+09:00", { energy: 200 }),
      item("a", "2026-03-10T08:00:00+09:00", { energy: 200 }),
    ]);
    expect(r2.get("2026-03-10")?.source).toBe("a");
  });
});

describe("buildDays + nutrition", () => {
  it("CSV の日にマージし、無い日は作る。範囲で絞り、スキーマに通る", () => {
    const csvDays = [{ date: "2026-03-10", activity: { steps: 100 } }];
    const nutrition = [
      item("a", "2026-03-10T08:00:00+09:00", { energy: 500, protein: 20 }),
      item("a", "2026-03-12T08:00:00+09:00", { energy: 800 }),
      item("a", "2026-04-01T08:00:00+09:00", { energy: 900 }),
    ];
    const { days } = buildDays(csvDays, [], { from: "2026-03-01", to: "2026-03-31" }, nutrition);
    expect(days.map((d) => d.date)).toEqual(["2026-03-10", "2026-03-12"]);
    expect(days[0]).toMatchObject({
      activity: { steps: 100 },
      nutrition: { energy_kcal: 500, protein_g: 20 },
    });
    expect(days[1]?.nutrition).toEqual({ energy_kcal: 800 });
    for (const d of days) expect(DailySummarySchema.safeParse(d).success).toBe(true);
  });
});
