import { JST_OFFSET_MS } from "../domain/dates.js";

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"] as const;

// ノートを直接編集する人や AI 向けの注意書き。Obsidian のコメントなので閲覧画面には出ない
export const GENERATED_NOTICE =
  "%% このノートは sync-google-health-api のサーバーが自動で作ります。直接編集しても次の同期で元に戻ります。変えたいときは、リポジトリの server/src/notes/ を変更してください %%\n";

export function numOrNull(x: number | null | undefined): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

// 任意のオフセット付き ISO 文字列を Asia/Tokyo の "HH:MM" に変換
export function jstHm(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const d = new Date(t + JST_OFFSET_MS);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

// "YYYY-MM-DD" の曜日（暦上の曜日なのでタイムゾーン非依存）
export function weekdayJa(date: string): string {
  return WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()] ?? "";
}

// "YYYY-MM" を前後の月にずらす
export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const idx = y * 12 + (m - 1) + delta;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
}

export function monthLabelJa(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${y}年${m}月`;
}

export function fmtNum(x: number): string {
  return x.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

export function fmtDuration(minutes: number): string {
  const m = Math.round(minutes);
  return m >= 60 ? `${Math.floor(m / 60)}時間${m % 60}分` : `${m}分`;
}
