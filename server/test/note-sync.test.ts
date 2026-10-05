import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { MemoryStore } from "../src/store/memory-store.js";
import { createNoteSync, NOTE_FAILURE_MESSAGE, NoteSync } from "../src/sync/note-sync.js";
import { MemoryVaultWriter } from "../src/vault/memory-vault-writer.js";
import {
  assertVaultPath,
  DEFAULT_VAULT_PREFIX,
  noteRootFromPrefix,
  VaultWriteError,
} from "../src/vault/vault-writer.js";

let errorLog: MockInstance<typeof console.error>;
beforeEach(() => {
  errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  errorLog.mockRestore();
});

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

  it("マーカーの無い手書きノートは上書きせず failed に載せる", async () => {
    const { store, sync, writer } = setup();
    await store.upsertDays([
      { date: "2026-02-01", activity: { steps: 1 } },
      { date: "2026-02-02", activity: { steps: 2 } },
    ]);
    const path = "Health/Daily/2026-02-01.md";
    const handwritten = "# 2月1日\n手書きの日記\n";
    writer.notes.set(path, handwritten);
    const r = await sync.syncDates(["2026-02-01", "2026-02-02"]);
    expect(writer.notes.get(path)).toBe(handwritten);
    expect(r.written).not.toContain(path);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]!.path).toBe(path);
    expect(r.failed[0]!.error).toMatch(/マーカー/);
    // 他のノートは通常どおり書き込まれる
    expect(r.written).toContain("Health/Daily/2026-02-02.md");
    expect(r.written).toContain("Health/Monthly/2026-02.md");
  });

  it("空白だけの既存ノートは上書きする", async () => {
    const { store, sync, writer } = setup();
    await store.upsertDays([{ date: "2026-02-01", activity: { steps: 1 } }]);
    const path = "Health/Daily/2026-02-01.md";
    writer.notes.set(path, "\n  \n");
    const r = await sync.syncDates(["2026-02-01"]);
    expect(r.failed).toEqual([]);
    expect(r.written).toContain(path);
    expect(writer.notes.get(path)).toContain("%% health:memo");
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
    // 内部のエラー文は応答に出さず、固定の文にしてログにだけ残す
    expect(r.failed).toEqual([{ path: bad, error: NOTE_FAILURE_MESSAGE }]);
    expect(r.written).toHaveLength(2);
    expect(writer.notes.has(bad)).toBe(false);
    expect(errorLog.mock.calls.flat().join("\n")).toContain("boom");
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
    expect(r.failed.every((f) => f.error === NOTE_FAILURE_MESSAGE)).toBe(true);
    expect(r.written).toEqual([]);
  });

  it("Vault の内部エラー（URL などを含む）は応答に出さない", async () => {
    const { store, writer } = setup();
    writer.writeNote = async () => {
      throw new VaultWriteError("Vault の write_note が失敗: connect ECONNREFUSED 10.0.0.1:443");
    };
    const sync = new NoteSync({ store, writer });
    await store.upsertDays([{ date: "2026-02-01", activity: { steps: 1 } }]);
    const r = await sync.syncDates(["2026-02-01"]);
    expect(JSON.stringify(r)).not.toContain("ECONNREFUSED");
    expect(r.failed.map((f) => f.error)).toEqual([NOTE_FAILURE_MESSAGE, NOTE_FAILURE_MESSAGE]);
    expect(errorLog.mock.calls.flat().join("\n")).toContain("ECONNREFUSED");
  });

  it("利用者が対処できるパスのエラーは文面をそのまま返す", async () => {
    const store = new MemoryStore();
    // 生成先（Health）と許可フォルダ（Other/）が食い違う設定
    const writer = new MemoryVaultWriter({ prefix: "Other/" });
    const sync = new NoteSync({ store, writer });
    await store.upsertDays([{ date: "2026-02-01", activity: { steps: 1 } }]);
    const r = await sync.syncDates(["2026-02-01"]);
    expect(r.failed).toHaveLength(2);
    for (const f of r.failed) expect(f.error).toMatch(/不正な Vault パスです/);
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

describe("VAULT_HEALTH_PREFIX に合わせたルート", () => {
  it.each([
    ["Health/", "Health"],
    ["Health", "Health"],
    ["MyHealth/", "MyHealth"],
    ["Areas/Health/", "Areas/Health"],
  ])("noteRootFromPrefix(%s) は %s", (prefix, root) => {
    expect(noteRootFromPrefix(prefix)).toBe(root);
  });

  it.each(["MyHealth/", "Areas/Health/"])(
    "プレフィックス %s の下に全てのノートを書き込む",
    async (prefix) => {
      const root = noteRootFromPrefix(prefix);
      const store = new MemoryStore();
      // MemoryVaultWriter は読み書きのたびに assertVaultPath でプレフィックスを検証する
      const writer = new MemoryVaultWriter({ prefix });
      const sync = new NoteSync({ store, writer, root });
      await store.upsertDays([
        { date: "2026-02-01", activity: { steps: 1 } },
        { date: "2026-02-02", activity: { steps: 2 } },
      ]);
      const r = await sync.syncRange("2026-02-01", "2026-02-02", { includeStatic: true });
      expect(r.failed).toEqual([]);
      expect([...writer.notes.keys()].sort()).toEqual(
        [
          `${root}/Daily/2026-02-01.md`,
          `${root}/Daily/2026-02-02.md`,
          `${root}/Monthly/2026-02.md`,
          `${root}/ヘルスケアダッシュボード.md`,
          `${root}/睡眠ダッシュボード.md`,
          `${root}/_bases/日次ログ.base`,
          `${root}/_bases/睡眠ログ.base`,
          `${root}/_bases/月次サマリー.base`,
        ].sort(),
      );
      for (const path of writer.notes.keys()) {
        expect(() => assertVaultPath(path, prefix)).not.toThrow();
      }

      // リンクやフォルダの参照も同じルートを指す
      expect(writer.notes.get(`${root}/Daily/2026-02-01.md`)).toContain(
        `[[${root}/Daily/2026-02-02|翌日]]`,
      );
      expect(writer.notes.get(`${root}/ヘルスケアダッシュボード.md`)).toContain(
        `dv.pages('"${root}/Daily"')`,
      );
      expect(writer.notes.get(`${root}/_bases/月次サマリー.base`)).toContain(
        `file.inFolder("${root}/Monthly")`,
      );
      for (const content of writer.notes.values()) {
        expect(content).not.toMatch(/(^|[^/\w])Health\/(Daily|Monthly)/);
      }
    },
  );

  it("createNoteSync はプレフィックスの下にノートを生成する", async () => {
    const store = new MemoryStore();
    const writer = new MemoryVaultWriter({ prefix: "Other/" });
    await store.upsertDays([{ date: "2026-02-01", activity: { steps: 1 } }]);
    const r = await createNoteSync({ store, writer, prefix: "Other/" }).syncDates(["2026-02-01"]);
    expect(r.failed).toEqual([]);
    expect(writer.notes.has("Other/Daily/2026-02-01.md")).toBe(true);
  });

  it("既定のプレフィックスから求めたルートは、ルート省略時と同じ出力になる", async () => {
    const store = new MemoryStore();
    await store.upsertDays([{ date: "2026-02-01", activity: { steps: 1 } }]);
    const a = new MemoryVaultWriter();
    const b = new MemoryVaultWriter();
    await new NoteSync({ store, writer: a }).syncRange("2026-02-01", "2026-02-01", {
      includeStatic: true,
    });
    await new NoteSync({
      store,
      writer: b,
      root: noteRootFromPrefix(DEFAULT_VAULT_PREFIX),
    }).syncRange("2026-02-01", "2026-02-01", { includeStatic: true });
    expect(b.notes.size).toBeGreaterThan(0);
    expect([...b.notes.entries()]).toEqual([...a.notes.entries()]);
  });
});
