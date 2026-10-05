import { scrubToken } from "./cli-guard.js";

// POST /api/ingest の応答の notes。Vault 未設定なら null、同期自体が失敗したら error
export type IngestNotes =
  | { kind: "none" }
  | {
      kind: "synced";
      written: number;
      unchanged: number;
      failed: { path: string; error: string }[];
    }
  | { kind: "error"; error: string };

// 想定外の形は同期の失敗として扱う（成功に見せない）
export function parseIngestNotes(value: unknown, token: string | undefined): IngestNotes {
  if (value === null || value === undefined) return { kind: "none" };
  const v = value as { written?: unknown; unchanged?: unknown; failed?: unknown; error?: unknown };
  if (typeof v.written === "number" && typeof v.unchanged === "number" && Array.isArray(v.failed)) {
    return {
      kind: "synced",
      written: v.written,
      unchanged: v.unchanged,
      failed: v.failed.map((f: { path?: unknown; error?: unknown } | null) => ({
        path: String(f?.path ?? "?"),
        error: scrubToken(String(f?.error ?? "?"), token),
      })),
    };
  }
  const error = typeof v.error === "string" ? v.error : "応答の形が想定外です";
  return { kind: "error", error: scrubToken(error, token) };
}

export function formatNotes(n: IngestNotes): string {
  switch (n.kind) {
    case "none":
      return "";
    case "synced":
      return ` ノート: 書き込み ${n.written} / 変更なし ${n.unchanged} / 失敗 ${n.failed.length}`;
    case "error":
      return " ノート: 同期に失敗";
  }
}

export type NotesTotal = {
  written: number;
  unchanged: number;
  failed: number;
  batchErrors: number;
};

export function addNotes(total: NotesTotal, n: IngestNotes): NotesTotal {
  if (n.kind === "synced") {
    return {
      ...total,
      written: total.written + n.written,
      unchanged: total.unchanged + n.unchanged,
      failed: total.failed + n.failed.length,
    };
  }
  if (n.kind === "error") return { ...total, batchErrors: total.batchErrors + 1 };
  return total;
}
