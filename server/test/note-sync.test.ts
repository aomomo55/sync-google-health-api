import { describe, expect, it } from "vitest";
import { MemoryStore } from "../src/store/memory-store.js";
import { NoteSync } from "../src/sync/note-sync.js";
import { MemoryVaultWriter } from "../src/vault/memory-vault-writer.js";

function setup() {
  const store = new MemoryStore();
  const writer = new MemoryVaultWriter();
  return { store, writer, sync: new NoteSync({ store, writer }) };
}

describe("NoteSync", () => {
  it("初回は全て書き込み、2回目は全て変更なし", async () => {
    const { store, sync, writer } = setup();
    await store.upsertDays([
      { date: "2026-02-01", activity: { steps: 1 } },
      { date: "2026-02-02", activity: { steps: 2 } },
    ]);
    const r1 = await sync.syncDates(["2026-02-01", "2026-02-02"]);
    expect(r1.written).toHaveLength(3);
    expect(r1.unchanged).toEqual([]);
    expect(writer.notes.size).toBe(3);
    const r2 = await sync.syncDates(["2026-02-01", "2026-02-02"]);
    expect(r2.written).toEqual([]);
    expect(r2.unchanged).toHaveLength(3);
  });

  it("長く途切れたデータでも、区切った範囲の同期で前後リンクを消さない", async () => {
    const { store, sync, writer } = setup();
    // 2025-01-10 の次のデータは 200 日以上後
    await store.upsertDays([
      { date: "2025-01-09", activity: { steps: 1 } },
      { date: "2025-01-10", activity: { steps: 2 } },
      { date: "2025-08-01", activity: { steps: 3 } },
      { date: "2025-08-02", activity: { steps: 4 } },
    ]);
    await sync.syncRange("2025-01-01", "2025-12-31");
    const before = writer.notes.get("Health/Daily/2025-01-10.md")!;
    expect(before).toContain("[[Health/Daily/2025-08-01|翌日]]");

    // 途切れの手前だけ・奥だけを対象にしても、リンクは保たれ書き換えも起きない
    const r1 = await sync.syncRange("2025-01-01", "2025-01-31");
    const r2 = await sync.syncRange("2025-08-01", "2025-08-31");
    expect(r1.written).toEqual([]);
    expect(r2.written).toEqual([]);
    expect(writer.notes.get("Health/Daily/2025-01-10.md")).toBe(before);
    expect(writer.notes.get("Health/Daily/2025-08-01.md")).toContain(
      "[[Health/Daily/2025-01-10|前日]]",
    );
  });

  it("ユーザーのメモを保持する", async () => {
    const { store, sync, writer } = setup();
    await store.upsertDays([{ date: "2026-02-01", activity: { steps: 1 } }]);
    await sync.syncDates(["2026-02-01"]);
    const path = "Health/Daily/2026-02-01.md";
    writer.notes.set(path, `${writer.notes.get(path)!}\n大事なメモ\n`);
    await store.upsertDays([{ date: "2026-02-01", activity: { steps: 999 } }]);
    const r = await sync.syncDates(["2026-02-01"]);
    expect(r.written).toContain(path);
    const note = writer.notes.get(path)!;
    expect(note).toContain("大事なメモ");
    expect(note).toContain("999");
  });

  it("後日のデータ追加で前日ノートの翌日リンクと月次が更新される", async () => {
    const { store, sync, writer } = setup();
    await store.upsertDays([{ date: "2026-02-20", activity: { steps: 1 } }]);
    await sync.syncDates(["2026-02-20"]);
    expect(writer.notes.get("Health/Daily/2026-02-20.md")).not.toContain("翌日");
    await store.upsertDays([{ date: "2026-03-05", activity: { steps: 5 } }]);
    const r = await sync.syncDates(["2026-03-05"]);
    expect(writer.notes.get("Health/Daily/2026-02-20.md")).toContain("Daily/2026-03-05|翌日");
    expect(r.written).toContain("Health/Daily/2026-02-20.md");
    expect(r.written).toContain("Health/Monthly/2026-03.md");
    expect(r.unchanged).toContain("Health/Monthly/2026-02.md");
  });

  it("データの無い日だけなら何もしない", async () => {
    const { sync } = setup();
    expect(await sync.syncDates(["2026-02-01"])).toEqual({
      written: [],
      unchanged: [],
      failed: [],
    });
  });

  it("1ノートの失敗は報告し、他は書き込む", async () => {
    const { store, writer } = setup();
    const bad = "Health/Daily/2026-02-02.md";
    const orig = writer.writeNote.bind(writer);
    writer.writeNote = async (p, c) => {
      if (p === bad) throw new Error("boom");
      return orig(p, c);
    };
    const sync = new NoteSync({ store, writer });
    await store.upsertDays([
      { date: "2026-02-01", activity: { steps: 1 } },
      { date: "2026-02-02", activity: { steps: 2 } },
    ]);
    const r = await sync.syncDates(["2026-02-01", "2026-02-02"]);
    expect(r.failed).toEqual([{ path: bad, error: "boom" }]);
    expect(r.written).toHaveLength(2);
    expect(writer.notes.has(bad)).toBe(false);
  });

  it("読み取り失敗も failed に入る", async () => {
    const { store, writer } = setup();
    writer.readNote = async () => {
      throw new Error("read fail");
    };
    const sync = new NoteSync({ store, writer });
    await store.upsertDays([{ date: "2026-02-01", activity: { steps: 1 } }]);
    const r = await sync.syncDates(["2026-02-01"]);
    expect(r.failed).toHaveLength(2);
    expect(r.written).toEqual([]);
  });

  it("syncRange は範囲内の全日・月と静的ノートを扱う", async () => {
    const { store, sync, writer } = setup();
    const days = Array.from({ length: 70 }, (_, i) => ({
      date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
      activity: { steps: 100 + i },
    }));
    await store.upsertDays(days);
    const r = await sync.syncRange("2026-01-01", "2026-03-11", { includeStatic: true });
    // 日次70 + 月次3 + 静的5
    expect(r.written).toHaveLength(78);
    expect(r.failed).toEqual([]);
    expect(writer.notes.size).toBe(78);
    const r2 = await sync.syncRange("2026-01-01", "2026-03-11", { includeStatic: true });
    expect(r2.unchanged).toHaveLength(78);
  });

  it("範囲の端でも月次は月全体で集計される", async () => {
    const { store, sync, writer } = setup();
    await store.upsertDays([
      { date: "2026-02-01", activity: { steps: 1000 } },
      { date: "2026-02-20", activity: { steps: 3000 } },
    ]);
    await sync.syncRange("2026-02-20", "2026-02-20");
    expect(writer.notes.get("Health/Monthly/2026-02.md")).toContain("2000");
  });
});
