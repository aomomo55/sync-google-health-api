import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DailySummary } from "../domain/daily.js";
import { parseDailyCsv } from "./daily-csv.js";
import { parseSleepJson, sourceFromFilename, type Segment } from "./sleep.js";

export const DAILY_CSV_PATH = ["日別のアクティビティ指標", "日別のアクティビティ指標.csv"];
export const RAW_DIR = "すべてのデータ";

// Takeout/Fit ディレクトリから日次 CSV と睡眠 segment を読む（derived_* は無視）
export async function loadTakeout(
  root: string,
): Promise<{ csvDays: DailySummary[]; segments: Segment[]; files: string[] }> {
  const csvDays = parseDailyCsv(await readFile(join(root, ...DAILY_CSV_PATH), "utf8"));
  const rawDir = join(root, RAW_DIR);
  const segments: Segment[] = [];
  const files: string[] = [];
  for (const name of (await readdir(rawDir)).sort()) {
    const source = sourceFromFilename(name);
    if (!source) continue;
    files.push(name);
    const json: unknown = JSON.parse(await readFile(join(rawDir, name), "utf8"));
    for (const seg of parseSleepJson(json, source)) segments.push(seg);
  }
  return { csvDays, segments, files };
}
