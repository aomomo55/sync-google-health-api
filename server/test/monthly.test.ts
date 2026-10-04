import { describe, expect, it } from "vitest";
import type { DailySummary } from "../src/domain/daily.js";
import { summarizeMonth, summarizeMonths } from "../src/domain/monthly.js";

const sleepDay = (date: string, start: string): DailySummary => ({
  date,
  sleep: { start, asleep_minutes: 400 },
});

describe("summarizeMonth", () => {
  it("23:30 と 00:30 の平均就寝時刻は 00:00", () => {
    const m = summarizeMonth("2026-01", [
      sleepDay("2026-01-01", "2025-12-31T23:30:00+09:00"),
      sleepDay("2026-01-02", "2026-01-02T00:30:00+09:00"),
    ]);
    expect(m.sleep.avg_bedtime).toBe("00:00");
  });

  it("22:00 と 23:00 は 22:30", () => {
    const m = summarizeMonth("2026-01", [
      sleepDay("2026-01-01", "2026-01-01T22:00:00+09:00"),
      sleepDay("2026-01-02", "2026-01-02T23:00:00+09:00"),
    ]);
    expect(m.sleep.avg_bedtime).toBe("22:30");
  });

  it("データが無ければ null と 0", () => {
    const m = summarizeMonth("2026-01", []);
    expect(m.days_with_data).toBe(0);
    expect(m.activity.avg_steps).toBeNull();
    expect(m.sleep.nights).toBe(0);
  });

  it("丸め: 歩数は整数、体重は小数1桁、距離は km 小数2桁", () => {
    const m = summarizeMonth("2026-01", [
      { date: "2026-01-01", activity: { steps: 1, distance_m: 1234 }, body: { weight_kg: 60.04 } },
      { date: "2026-01-02", activity: { steps: 2 }, body: { weight_kg: 60.1 } },
    ]);
    expect(m.activity.avg_steps).toBe(2);
    expect(m.activity.total_distance_km).toBe(1.23);
    expect(m.body.avg_weight_kg).toBe(60.1);
  });
});

describe("summarizeMonth: カロリー", () => {
  it("消費の平均と、摂取の記録日数・平均（値のある日だけで平均）", () => {
    const m = summarizeMonth("2026-01", [
      {
        date: "2026-01-01",
        activity: { calories_kcal: 2000 },
        nutrition: { energy_kcal: 1800, protein_g: 70, fat_g: 50, carbs_g: 200 },
      },
      {
        date: "2026-01-02",
        activity: { calories_kcal: 2101 },
        nutrition: { energy_kcal: 2001, protein_g: 75.5 },
      },
      { date: "2026-01-03", activity: { steps: 1 }, nutrition: { energy_kcal: null } },
    ]);
    expect(m.activity.avg_calories_kcal).toBe(2051); // 2050.5 → 四捨五入
    expect(m.nutrition).toEqual({
      days_logged: 2,
      avg_energy_kcal: 1901, // 1900.5
      avg_protein_g: 72.8, // 72.75
      avg_fat_g: 50,
      avg_carbs_g: 200,
    });
  });

  it("摂取だけの日も計測日数に含まれ、無ければ null と 0", () => {
    const m = summarizeMonth("2026-01", [{ date: "2026-01-01", nutrition: { fat_g: 10 } }]);
    expect(m.days_with_data).toBe(1);
    expect(m.nutrition.days_logged).toBe(1);
    expect(m.nutrition.avg_energy_kcal).toBeNull();
    const e = summarizeMonth("2026-01", []);
    expect(e.nutrition.days_logged).toBe(0);
    expect(e.activity.avg_calories_kcal).toBeNull();
  });
});

describe("summarizeMonths", () => {
  it("月ごとに昇順でグルーピングし、全て null の日だけの月は除く", () => {
    const r = summarizeMonths([
      { date: "2026-02-01", activity: { steps: 10 } },
      { date: "2026-01-01", activity: { steps: 20 } },
      { date: "2026-03-01", activity: { steps: null } },
    ]);
    expect(r.map((m) => m.month)).toEqual(["2026-01", "2026-02"]);
  });
});
