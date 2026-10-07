import type { DailySummary } from "../domain/daily.js";
import { isRealDate, MS_PER_MINUTE } from "../domain/dates.js";
import { round } from "../shared/rounding.js";
import { parseCsv } from "./csv.js";

export const TAKEOUT_SOURCE = "takeout";

function cell(row: string[], idx: number | undefined): number | undefined {
  if (idx === undefined) return undefined;
  const raw = row[idx]?.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

// undefined のキーを落とす。空なら undefined（セクションごと省略するため）
function compact<K extends string>(
  o: Record<K, number | undefined>,
): Partial<Record<K, number>> | undefined {
  const entries = (Object.keys(o) as K[]).flatMap((k) => {
    const v = o[k];
    return v === undefined ? [] : [[k, v] as const];
  });
  return entries.length > 0
    ? (Object.fromEntries(entries) as Partial<Record<K, number>>)
    : undefined;
}

const opt = (v: number | undefined, f: (n: number) => number) =>
  v === undefined ? undefined : f(v);

// 日別アクティビティ指標 CSV → DailySummary[]。列はヘッダー名で引く（BOM 可）
export function parseDailyCsv(text: string): DailySummary[] {
  const rows = parseCsv(text);
  const header = rows[0];
  if (!header) return [];
  const col = new Map<string, number>();
  header.forEach((h, i) => {
    col.set(h.trim(), i);
  });
  const c = (name: string) => col.get(name);
  const dateIdx = c("日付");
  if (dateIdx === undefined) throw new Error("CSV に「日付」列がありません");

  const days: DailySummary[] = [];
  for (const row of rows.slice(1)) {
    const date = row[dateIdx]?.trim() ?? "";
    if (!isRealDate(date)) continue;
    const activity = compact({
      // 受信側は歩数を整数に限るので、念のため丸める
      steps: opt(cell(row, c("歩数")), Math.round),
      distance_m: opt(cell(row, c("距離（m）")), (n) => round(n, 1)),
      calories_kcal: opt(cell(row, c("カロリー（kcal）")), (n) => round(n, 1)),
      move_minutes: cell(row, c("通常の運動（分）のカウント")),
      heart_points: cell(row, c("ハートポイント（強めの運動）")),
      vigorous_minutes: cell(row, c("強めの運動（分）")),
      walking_minutes: opt(cell(row, c("「ウォーキング」の時間（ミリ秒）")), (n) =>
        round(n / MS_PER_MINUTE, 1),
      ),
    });
    const heart_rate = compact({
      avg_bpm: opt(cell(row, c("平均心拍数（拍 / 分）")), (n) => round(n, 1)),
      max_bpm: cell(row, c("最大心拍数（拍 / 分）")),
      min_bpm: cell(row, c("最小心拍数（拍 / 分）")),
    });
    const body = compact({
      weight_kg: opt(cell(row, c("平均体重（kg）")), (n) => round(n, 2)),
    });
    const day: DailySummary = { date, source: TAKEOUT_SOURCE };
    if (activity) day.activity = activity;
    if (heart_rate) day.heart_rate = heart_rate;
    if (body) day.body = body;
    days.push(day);
  }
  return days;
}
