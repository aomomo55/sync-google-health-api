import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DailySummary } from "../domain/daily.js";
import { parseDailyCsv } from "./daily-csv.js";
import {
  type NutritionItem,
  nutritionSourceFromFilename,
  parseNutritionJson,
} from "./nutrition.js";
import { type ParseStats, parseSleepJson, type Segment, sourceFromFilename } from "./sleep.js";

export const DAILY_CSV_PATH = ["日別のアクティビティ指標", "日別のアクティビティ指標.csv"];
export const RAW_DIR = "すべてのデータ";

// Takeout/Fit ディレクトリから日次 CSV と睡眠 segment を読む（derived_* は無視）
export async function loadTakeout(root: string): Promise<{
  csvDays: DailySummary[];
  segments: Segment[];
  nutrition: NutritionItem[];
  files: string[];
  nutritionFiles: string[];
  // 時刻が不正で捨てた記録の件数
  dropped: { sleep: number; nutrition: number };
}> {
  const csvDays = parseDailyCsv(await readFile(join(root, ...DAILY_CSV_PATH), "utf8"));
  const rawDir = join(root, RAW_DIR);
  const segments: Segment[] = [];
  const nutrition: NutritionItem[] = [];
  const files: string[] = [];
  const nutritionFiles: string[] = [];
  const sleepStats: ParseStats = { invalidTime: 0 };
  const nutritionStats: ParseStats = { invalidTime: 0 };
  for (const name of (await readdir(rawDir)).sort()) {
    const sleepSource = sourceFromFilename(name);
    if (sleepSource) {
      files.push(name);
      const json: unknown = JSON.parse(await readFile(join(rawDir, name), "utf8"));
      for (const seg of parseSleepJson(json, sleepSource, sleepStats)) segments.push(seg);
      continue;
    }
    const nutritionSource = nutritionSourceFromFilename(name);
    if (nutritionSource) {
      nutritionFiles.push(name);
      const json: unknown = JSON.parse(await readFile(join(rawDir, name), "utf8"));
      for (const item of parseNutritionJson(json, nutritionSource, nutritionStats))
        nutrition.push(item);
    }
  }
  return {
    csvDays,
    segments,
    nutrition,
    files,
    nutritionFiles,
    dropped: { sleep: sleepStats.invalidTime, nutrition: nutritionStats.invalidTime },
  };
}
