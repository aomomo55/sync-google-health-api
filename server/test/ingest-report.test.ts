import { describe, expect, it } from "vitest";
import { addNotes, formatNotes, parseIngestNotes } from "../scripts/ingest-report.js";

const TOKEN = "abcdefghijklmnopqrstuvwxyz012345";

describe("parseIngestNotes", () => {
  it("Vault 未設定（null）は表示しない", () => {
    const n = parseIngestNotes(null, TOKEN);
    expect(n).toEqual({ kind: "none" });
    expect(formatNotes(n)).toBe("");
  });

  it("同期結果を件数で表示し、失敗の文からトークンを伏せる", () => {
    const n = parseIngestNotes(
      {
        written: 3,
        unchanged: 27,
        failed: [{ path: "Health/Daily/2026-03-01.md", error: `x ${TOKEN}` }],
      },
      TOKEN,
    );
    expect(formatNotes(n)).toBe(" ノート: 書き込み 3 / 変更なし 27 / 失敗 1");
    expect(n.kind === "synced" && n.failed[0]!.error).not.toContain(TOKEN);
  });

  it("同期全体の失敗と想定外の形は、失敗として扱う", () => {
    expect(parseIngestNotes({ error: "ノートの同期に失敗しました" }, TOKEN)).toEqual({
      kind: "error",
      error: "ノートの同期に失敗しました",
    });
    expect(parseIngestNotes({ written: "3" }, TOKEN).kind).toBe("error");
    expect(formatNotes({ kind: "error", error: "x" })).toBe(" ノート: 同期に失敗");
  });
});

describe("addNotes", () => {
  it("バッチごとの結果を合計する", () => {
    let t = { written: 0, unchanged: 0, failed: 0, batchErrors: 0 };
    t = addNotes(t, { kind: "synced", written: 2, unchanged: 28, failed: [] });
    t = addNotes(t, {
      kind: "synced",
      written: 1,
      unchanged: 28,
      failed: [{ path: "a.md", error: "e" }],
    });
    t = addNotes(t, { kind: "error", error: "e" });
    t = addNotes(t, { kind: "none" });
    expect(t).toEqual({ written: 3, unchanged: 56, failed: 1, batchErrors: 1 });
  });
});
