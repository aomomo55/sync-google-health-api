import type { DailySummary } from "../domain/daily.js";
import { TAKEOUT_SOURCE } from "./daily-csv.js";
import { buildNutritionByDate, type ChosenNutrition, type NutritionItem } from "./nutrition.js";
import { buildSleepByDate, type ChosenSleep, type Segment } from "./sleep.js";

export { parseDailyCsv } from "./daily-csv.js";
export {
  MAX_DATA_POINTS_PER_FILE,
  type ParseStats,
  TakeoutLimitError,
} from "./data-points.js";
export {
  buildNutritionByDate,
  type ChosenNutrition,
  type NutritionItem,
  nutritionSourceFromFilename,
  parseNutritionJson,
} from "./nutrition.js";
export type { ChosenSleep, Segment } from "./sleep.js";
export {
  buildSleepByDate,
  parseSleepJson,
  sourceFromFilename,
} from "./sleep.js";

export type BuildResult = {
  days: DailySummary[]; // 日付昇順
  sleepByDate: Map<string, ChosenSleep>;
  nutritionByDate: Map<string, ChosenNutrition>;
};

// CSV 由来の日次と睡眠を日付で結合する（CSV に無い日は睡眠だけの日として作る）
export function buildDays(
  csvDays: DailySummary[],
  segments: Segment[],
  range: { from?: string; to?: string } = {},
  nutrition: NutritionItem[] = [],
): BuildResult {
  const sleepByDate = buildSleepByDate(segments);
  const nutritionByDate = buildNutritionByDate(nutrition);
  // 同じ日付が CSV に複数あれば後のものを使う
  const csvByDate = new Map(csvDays.map((d) => [d.date, d]));
  const dates = new Set([...csvByDate.keys(), ...sleepByDate.keys(), ...nutritionByDate.keys()]);
  const days = [...dates]
    .map((date): DailySummary => {
      const sleep = sleepByDate.get(date)?.sleep;
      const nutrition = nutritionByDate.get(date)?.nutrition;
      return {
        ...(csvByDate.get(date) ?? { date, source: TAKEOUT_SOURCE }),
        ...(sleep ? { sleep } : {}),
        ...(nutrition ? { nutrition } : {}),
      };
    })
    .filter((d) => (!range.from || d.date >= range.from) && (!range.to || d.date <= range.to))
    .sort((a, b) => a.date.localeCompare(b.date));
  return { days, sleepByDate, nutritionByDate };
}
