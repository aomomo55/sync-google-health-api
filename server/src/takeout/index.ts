import type { DailySummary } from "../domain/daily.js";
import { TAKEOUT_SOURCE } from "./daily-csv.js";
import { buildNutritionByDate, type ChosenNutrition, type NutritionItem } from "./nutrition.js";
import { buildSleepByDate, type ChosenSleep, type Segment } from "./sleep.js";

export { parseDailyCsv } from "./daily-csv.js";
export {
  buildNutritionByDate,
  type ChosenNutrition,
  type NutritionItem,
  nutritionSourceFromFilename,
  parseNutritionJson,
} from "./nutrition.js";
export type { ChosenSleep, ParseStats, Segment } from "./sleep.js";
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
  const map = new Map<string, DailySummary>();
  for (const d of csvDays) map.set(d.date, { ...d });
  for (const [date, chosen] of sleepByDate) {
    const day = map.get(date) ?? { date, source: TAKEOUT_SOURCE };
    day.sleep = chosen.sleep;
    map.set(date, day);
  }
  for (const [date, chosen] of nutritionByDate) {
    const day = map.get(date) ?? { date, source: TAKEOUT_SOURCE };
    day.nutrition = chosen.nutrition;
    map.set(date, day);
  }
  const days = [...map.values()]
    .filter((d) => (!range.from || d.date >= range.from) && (!range.to || d.date <= range.to))
    .sort((a, b) => a.date.localeCompare(b.date));
  return { days, sleepByDate, nutritionByDate };
}
