import { z } from "zod";
import type { DailySummary } from "../domain/daily.js";
import { round } from "../shared/rounding.js";
import { NanosSchema, nanosToMs, type ParseStats, validDataPoints } from "./data-points.js";
import { isSaneTime, jstDate } from "./sleep.js";

type NutritionFields = NonNullable<DailySummary["nutrition"]>;

// 食事 1 件（1 データポイント）分の栄養。値の無い項目は undefined
export type NutritionItem = {
  source: string;
  time: number; // epoch ms
  energy?: number;
  protein?: number;
  fat?: number;
  carbs?: number;
};

export type ChosenNutrition = {
  source: string;
  nutrition: NutritionFields;
  entries: number;
};

// raw_com.google.nutrition_<source>.json → <source>（derived_* は対象外）
export function nutritionSourceFromFilename(name: string): string | undefined {
  const m = /^raw_com\.google\.nutrition_(.+)\.json$/.exec(name);
  return m?.[1];
}

// mapVal の key → NutritionItem の項目
const KEY_TO_FIELD = {
  calories: "energy",
  protein: "protein",
  "fat.total": "fat",
  "carbs.total": "carbs",
} as const;

// nutrition の Data Points の 1 件。mapVal の要素は { key, value: { fpVal } }。
// Takeout は他の項目（endTimeNanos、intVal など）も含むので、余分な項目は許す
const NutritionPointSchema = z.object({
  startTimeNanos: NanosSchema,
  fitValue: z
    .array(
      z.object({
        value: z
          .object({
            mapVal: z
              .array(
                z.object({
                  key: z.string(),
                  value: z.object({ fpVal: z.number().optional() }).optional(),
                }),
              )
              .optional(),
          })
          .optional(),
      }),
    )
    .optional(),
});

type NutritionValues = Omit<NutritionItem, "source" | "time">;

type NutritionPoint = z.infer<typeof NutritionPointSchema>;

// 1 件の mapVal から対象の項目を取り出す。値の無い項目、負の値は付けない
function nutritionFields(p: NutritionPoint): NutritionValues {
  const map = p.fitValue?.[0]?.value?.mapVal ?? [];
  const fields = map.flatMap((e) => {
    const field = Object.hasOwn(KEY_TO_FIELD, e.key)
      ? KEY_TO_FIELD[e.key as keyof typeof KEY_TO_FIELD]
      : undefined;
    const v = e.value?.fpVal;
    if (!field || v === undefined || !Number.isFinite(v) || v < 0) return [];
    return [[field, v] as const];
  });
  // fields の項目名は KEY_TO_FIELD の値に限られる
  return Object.fromEntries(fields) as NutritionValues;
}

// Takeout の raw nutrition JSON を NutritionItem[] にする。形や時刻が不正な記録は捨てて stats に数える
export function parseNutritionJson(
  json: unknown,
  source: string,
  stats?: ParseStats,
): NutritionItem[] {
  const points = validDataPoints(json, NutritionPointSchema, stats);
  const timed = points.filter((p) => isSaneTime(nanosToMs(p.startTimeNanos)));
  // 呼び出し側が複数ファイル分を合計するので、渡された stats に足し込む
  if (stats) stats.invalidTime += points.length - timed.length;
  return timed.flatMap((p) => {
    const fields = nutritionFields(p);
    if (Object.keys(fields).length === 0) return [];
    return [{ source, time: Math.round(nanosToMs(p.startTimeNanos)), ...fields }];
  });
}

type Acc = { entries: number } & NutritionValues;

const add = (a: number | undefined, b: number | undefined) => (b === undefined ? a : (a ?? 0) + b);

// 1 日・1 ソース分の食事を合計する
const sumItems = (list: NutritionItem[]): Acc =>
  list.reduce<Acc>(
    (acc, it) => ({
      entries: acc.entries + 1,
      energy: add(acc.energy, it.energy),
      protein: add(acc.protein, it.protein),
      fat: add(acc.fat, it.fat),
      carbs: add(acc.carbs, it.carbs),
    }),
    { entries: 0 },
  );

const totalKcal = (a: Acc) => a.energy ?? 0;

function chooseNutrition(bySource: Map<string, NutritionItem[]>): ChosenNutrition {
  const [source, acc] = [...bySource]
    .map(([source, list]) => [source, sumItems(list)] as const)
    .sort(
      (a, b) =>
        b[1].entries - a[1].entries ||
        totalKcal(b[1]) - totalKcal(a[1]) ||
        (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
    )[0]!;
  const nutrition: NutritionFields = {
    ...(acc.energy !== undefined ? { energy_kcal: Math.round(acc.energy) } : {}),
    ...(acc.protein !== undefined ? { protein_g: round(acc.protein, 1) } : {}),
    ...(acc.fat !== undefined ? { fat_g: round(acc.fat, 1) } : {}),
    ...(acc.carbs !== undefined ? { carbs_g: round(acc.carbs, 1) } : {}),
  };
  return { source, nutrition, entries: acc.entries };
}

// 全ソースの食事から、日付(JST)ごとに採用する栄養を決める。
// その日の記録件数が最も多いソースを採用し、同数なら合計 kcal が大きいもの、さらに同じなら source id の辞書順
export function buildNutritionByDate(items: NutritionItem[]): Map<string, ChosenNutrition> {
  // date -> source -> 食事。振り分けは Map に足していく（lib が ES2023 で Map.groupBy を使えないため）
  const byDate = new Map<string, Map<string, NutritionItem[]>>();
  for (const it of items) {
    const date = jstDate(it.time);
    const sources = byDate.get(date) ?? new Map<string, NutritionItem[]>();
    byDate.set(date, sources);
    const list = sources.get(it.source);
    if (list) list.push(it);
    else sources.set(it.source, [it]);
  }
  return new Map([...byDate].map(([date, sources]) => [date, chooseNutrition(sources)]));
}
