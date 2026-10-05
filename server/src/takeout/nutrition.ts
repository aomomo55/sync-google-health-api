import type { DailySummary } from "../domain/daily.js";
import { isSaneTime, jstDate, type ParseStats } from "./sleep.js";

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

// Takeout の raw nutrition JSON を NutritionItem[] にする。時刻が不正な記録は捨てて stats に数える
export function parseNutritionJson(
  json: unknown,
  source: string,
  stats?: ParseStats,
): NutritionItem[] {
  const points = (json as { "Data Points"?: unknown } | null)?.["Data Points"];
  if (!Array.isArray(points)) return [];
  const out: NutritionItem[] = [];
  for (const p of points as Record<string, unknown>[]) {
    const t = Number(p.startTimeNanos) / 1e6;
    if (!isSaneTime(t)) {
      if (stats) stats.invalidTime++;
      continue;
    }
    const fv = p.fitValue as { value?: { mapVal?: unknown } }[] | undefined;
    const map = fv?.[0]?.value?.mapVal;
    if (!Array.isArray(map)) continue;
    const fields = (map as { key?: unknown; value?: { fpVal?: unknown } }[]).flatMap((e) => {
      const field =
        typeof e.key === "string" ? (KEY_TO_FIELD as Record<string, string>)[e.key] : undefined;
      const v = e.value?.fpVal;
      if (!field || typeof v !== "number" || !Number.isFinite(v) || v < 0) return [];
      return [[field, v] as const];
    });
    if (fields.length > 0) {
      out.push({ source, time: Math.round(t), ...Object.fromEntries(fields) } as NutritionItem);
    }
  }
  return out;
}

const round = (x: number, digits: number) => {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
};

type Acc = { entries: number; energy?: number; protein?: number; fat?: number; carbs?: number };

const add = (a: number | undefined, b: number | undefined) => (b === undefined ? a : (a ?? 0) + b);

const totalKcal = (a: Acc) => a.energy ?? 0;

// 全ソースの食事から、日付(JST)ごとに採用する栄養を決める。
// その日の記録件数が最も多いソースを採用し、同数なら合計 kcal が大きいもの、さらに同じなら source id の辞書順
export function buildNutritionByDate(items: NutritionItem[]): Map<string, ChosenNutrition> {
  // date -> source -> 集計
  const byDate = new Map<string, Map<string, Acc>>();
  for (const it of items) {
    const date = jstDate(it.time);
    const sources = byDate.get(date) ?? new Map<string, Acc>();
    byDate.set(date, sources);
    const acc: Acc = sources.get(it.source) ?? { entries: 0 };
    acc.entries++;
    acc.energy = add(acc.energy, it.energy);
    acc.protein = add(acc.protein, it.protein);
    acc.fat = add(acc.fat, it.fat);
    acc.carbs = add(acc.carbs, it.carbs);
    sources.set(it.source, acc);
  }

  const result = new Map<string, ChosenNutrition>();
  for (const [date, sources] of byDate) {
    const [source, acc] = [...sources.entries()].sort(
      (a, b) =>
        b[1].entries - a[1].entries ||
        totalKcal(b[1]) - totalKcal(a[1]) ||
        (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
    )[0]!;
    const nutrition: NutritionFields = {};
    if (acc.energy !== undefined) nutrition.energy_kcal = Math.round(acc.energy);
    if (acc.protein !== undefined) nutrition.protein_g = round(acc.protein, 1);
    if (acc.fat !== undefined) nutrition.fat_g = round(acc.fat, 1);
    if (acc.carbs !== undefined) nutrition.carbs_g = round(acc.carbs, 1);
    result.set(date, { source, nutrition, entries: acc.entries });
  }
  return result;
}
