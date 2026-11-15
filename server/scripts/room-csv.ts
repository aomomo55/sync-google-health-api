// SwitchBot アプリの温湿度計の「データのエクスポート」の CSV を読む（ADR 0033）。
// メーカーの形式を知っているのはここと GAS（gas/room-climate.gs）だけにし、サーバーは読み取り値の形だけを知る
import { JST_OFFSET } from "../src/domain/dates.js";
import { type RoomReading, RoomReadingSchema } from "../src/domain/room.js";
import { issuePath } from "../src/shared/issue-path.js";

// 先頭の行。列の名前は単位を含む（例: temperature(℃)）ので、名前の始まりで確かめる
const EXPECTED_COLUMNS = ["timestamp", "temperature", "humidity"] as const;
// 時刻は端末の時刻（Asia/Tokyo とみなす）で、オフセットが無い
const TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;
const BOM = 0xfeff;

// 空の欄を 0 にしない（Number("") は 0）。NaN は検証で弾かれる
const toNumber = (s: string | undefined): number => (s?.trim() ? Number(s) : Number.NaN);

export interface RoomCsvResult {
  readings: RoomReading[];
  invalid: { line: number; error: string }[];
}

type RowResult = { line: number; reading: RoomReading } | { line: number; error: string };

function parseRow(line: number, cols: string[]): RowResult {
  const m = TIMESTAMP_RE.exec(cols[0]?.trim() ?? "");
  if (!m) return { line, error: "timestamp が YYYY-MM-DD HH:MM:SS の形ではありません" };
  const parsed = RoomReadingSchema.safeParse({
    time: `${m[1]}T${m[2]}${JST_OFFSET}`,
    temperature_c: toNumber(cols[1]),
    humidity_pct: toNumber(cols[2]),
  });
  if (parsed.success) return { line, reading: parsed.data };
  const issue = parsed.error.issues[0];
  return { line, error: issue ? `${issuePath(issue)}: ${issue.message}` : "値が不正です" };
}

export function parseRoomCsv(text: string): RoomCsvResult {
  const body = text.charCodeAt(0) === BOM ? text.slice(1) : text;
  const lines = body.split(/\r?\n/);
  const header = (lines[0] ?? "").split(",").map((c) => c.trim().toLowerCase());
  const headerOk = EXPECTED_COLUMNS.every((name, i) => header[i]?.startsWith(name));
  if (!headerOk) {
    throw new Error(
      `CSV の先頭の行が想定と違います（${EXPECTED_COLUMNS.join(", ")} で始まる列が必要です）`,
    );
  }
  const results = lines
    .slice(1)
    .map((l, i) => ({ line: i + 2, cols: l.split(",") }))
    .filter((r) => r.cols.some((c) => c.trim() !== ""))
    .map((r) => parseRow(r.line, r.cols));
  return {
    readings: results.flatMap((r) => ("reading" in r ? [r.reading] : [])),
    invalid: results.flatMap((r) => ("error" in r ? [r] : [])),
  };
}
