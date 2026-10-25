import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { DailySummary } from "../domain/daily.js";
import { parseDailyCsv } from "./daily-csv.js";
import { type ParseStats, TakeoutLimitError } from "./data-points.js";
import {
  type NutritionItem,
  nutritionSourceFromFilename,
  parseNutritionJson,
} from "./nutrition.js";
import { parseSleepJson, type Segment, sourceFromFilename } from "./sleep.js";

export const DAILY_CSV_PATH = ["日別のアクティビティ指標", "日別のアクティビティ指標.csv"];
export const RAW_DIR = "すべてのデータ";

const MIB = 1024 * 1024;
// Takeout の 1 ファイルあたりの大きさの上限。ステージ付きの睡眠を 10 年分入れても数十 MiB なので、
// 余裕を持たせつつ JSON.parse で扱える大きさに収める
export const MAX_TAKEOUT_FILE_BYTES = 256 * MIB;

// ファイルを読む。maxBytes を超えるものは読まずに TakeoutLimitError を投げる
export async function readTextLimited(path: string, maxBytes: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    if (size > maxBytes) {
      throw new TakeoutLimitError(
        `ファイルが大きすぎます（${size} バイト、上限 ${maxBytes} バイト）: ${path}。` +
          "Takeout のファイルが壊れていないか確かめ、書き出し直してください",
      );
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

// raw JSON を読んで解析する。件数の上限エラーには、どのファイルかを添える
async function parseRawFile<T>(
  rawDir: string,
  name: string,
  parse: (json: unknown) => T[],
): Promise<T[]> {
  const json: unknown = JSON.parse(
    await readTextLimited(join(rawDir, name), MAX_TAKEOUT_FILE_BYTES),
  );
  try {
    return parse(json);
  } catch (e) {
    if (e instanceof TakeoutLimitError) throw new TakeoutLimitError(`${name}: ${e.message}`);
    throw e;
  }
}

// ファイルを 1 つずつ順に読んで解析する（大きなファイルを同時にメモリへ載せないため）
async function parseRawFiles<T>(
  rawDir: string,
  names: string[],
  parse: (name: string, json: unknown) => T[],
): Promise<T[]> {
  // 順に読むため、結果を積み上げるループにする
  const out: T[][] = [];
  for (const name of names) out.push(await parseRawFile(rawDir, name, (json) => parse(name, json)));
  return out.flat();
}

// Takeout/Fit ディレクトリから日次 CSV と睡眠 segment を読む（derived_* は無視）
export async function loadTakeout(root: string): Promise<{
  csvDays: DailySummary[];
  segments: Segment[];
  nutrition: NutritionItem[];
  files: string[];
  nutritionFiles: string[];
  // 時刻が不正で捨てた記録の件数
  dropped: { sleep: number; nutrition: number };
  // 形が想定と違うので捨てた記録の件数
  malformed: { sleep: number; nutrition: number };
}> {
  const csvDays = parseDailyCsv(
    await readTextLimited(join(root, ...DAILY_CSV_PATH), MAX_TAKEOUT_FILE_BYTES),
  );
  const rawDir = join(root, RAW_DIR);
  const names = (await readdir(rawDir)).sort();
  const files = names.filter((name) => sourceFromFilename(name) !== undefined);
  const nutritionFiles = names.filter((name) => nutritionSourceFromFilename(name) !== undefined);
  // 解析関数が捨てた件数を足し込む入れ物
  const sleepStats: ParseStats = { invalidTime: 0, invalidShape: 0 };
  const nutritionStats: ParseStats = { invalidTime: 0, invalidShape: 0 };
  const segments = await parseRawFiles(rawDir, files, (name, json) =>
    parseSleepJson(json, sourceFromFilename(name)!, sleepStats),
  );
  const nutrition = await parseRawFiles(rawDir, nutritionFiles, (name, json) =>
    parseNutritionJson(json, nutritionSourceFromFilename(name)!, nutritionStats),
  );
  return {
    csvDays,
    segments,
    nutrition,
    files,
    nutritionFiles,
    dropped: { sleep: sleepStats.invalidTime, nutrition: nutritionStats.invalidTime },
    malformed: { sleep: sleepStats.invalidShape, nutrition: nutritionStats.invalidShape },
  };
}
