import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { createVaultWriter } from "../src/vault/index.js";
import { McpVaultWriter } from "../src/vault/mcp-vault-writer.js";
import { MemoryVaultWriter } from "../src/vault/memory-vault-writer.js";
import {
  assertVaultPath,
  VaultPathError,
  VaultWriteError,
  type VaultWriter,
  writeMany,
} from "../src/vault/vault-writer.js";
import { FakeObsidianMcp } from "./vault-fake-server.js";

const TOKEN = "vault-test-token-0123456789";
const fake = new FakeObsidianMcp(TOKEN);
const writers: McpVaultWriter[] = [];

function make(over: { token?: string; prefix?: string; timeoutMs?: number } = {}) {
  const w = new McpVaultWriter({
    url: fake.url,
    token: over.token ?? TOKEN,
    prefix: over.prefix,
    timeoutMs: over.timeoutMs ?? 5000,
    retryDelaysMs: [5, 5, 5],
  });
  writers.push(w);
  return w;
}

beforeAll(() => fake.start());
afterAll(() => fake.stop());
beforeEach(async () => {
  // 前テストのタイムアウト済みリクエストが終わるまで待つ
  while (fake.inflight > 0) await new Promise((r) => setTimeout(r, 20));
  fake.notes.clear();
  fake.dropSessions();
  fake.toolCalls = 0;
  fake.initializes = 0;
  fake.maxInflight = 0;
  fake.failToolCalls = [];
  fake.toolDelayMs = 0;
  fake.readResponses.clear();
  fake.toolErrors = [];
  // やり直しのログはテストの出力に出さない（回数の確認には使う）
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  await Promise.all(writers.splice(0).map((w) => w.close()));
  vi.restoreAllMocks();
});

describe("McpVaultWriter", () => {
  it("書き込んで読み戻せる（前置きは除かれる）", async () => {
    const w = make();
    await w.writeNote("Health/2026/a.md", "# 見出し\n\n本文---\n");
    expect(fake.notes.get("Health/2026/a.md")).toBe("# 見出し\n\n本文---\n");
    expect(await w.readNote("Health/2026/a.md")).toBe("# 見出し\n\n本文---\n");
  });

  it("存在しないノートは null", async () => {
    expect(await make().readNote("Health/none.md")).toBeNull();
  });

  it.each([
    "Error: chunk not found",
    "database does not exist",
    "Error reading note: Note not found in chunk index",
  ])("ノート不在以外のエラー（%s）は null にせず、やり直したうえで throw", async (msg) => {
    fake.readResponses.set("Health/a.md", { text: msg, isError: true });
    const err = await make()
      .readNote("Health/a.md")
      .catch((e) => e);
    expect(err).toBeInstanceOf(VaultWriteError);
    expect(String(err.message)).toContain(msg);
    // 1 回目 + やり直し 3 回
    expect(fake.toolCalls).toBe(4);
  });

  it("要求したパスと一致しない「Note not found」は不在とみなさない", async () => {
    fake.readResponses.set("Health/a.md", { text: "Note not found: memo", isError: false });
    expect(await make().readNote("Health/a.md")).toBe("Note not found: memo");
  });

  it("isError 付きでも「Note not found: <要求したパス>」と完全一致すれば不在とみなす", async () => {
    fake.readResponses.set("Health/Daily/2026-01-01.md", {
      text: "Note not found: Health/Daily/2026-01-01.md",
      isError: true,
    });
    expect(await make().readNote("Health/Daily/2026-01-01.md")).toBeNull();
  });

  it("実機と同じ isError なしの「Note not found: <パス>」も不在とみなす", async () => {
    fake.readResponses.set("Health/Daily/2026-01-02.md", {
      text: "Note not found: Health/Daily/2026-01-02.md",
      isError: false,
    });
    expect(await make().readNote("Health/Daily/2026-01-02.md")).toBeNull();
  });

  it("isError なしでも、要求と別のパスの「Note not found」は不在とみなさない", async () => {
    fake.readResponses.set("Health/Daily/2026-01-02.md", {
      text: "Note not found: Health/Daily/2026-01-03.md",
      isError: false,
    });
    expect(await make().readNote("Health/Daily/2026-01-02.md")).not.toBeNull();
  });

  it("読み出しのエラー文にトークンが含まれても伏せる", async () => {
    fake.readResponses.set("Health/a.md", { text: `Error: bad ${TOKEN}`, isError: true });
    const err = await make()
      .readNote("Health/a.md")
      .catch((e) => e);
    expect(err).toBeInstanceOf(VaultWriteError);
    expect(String(err.message)).not.toContain(TOKEN);
  });

  it("セッションを使い回す（initialize は 1 回）", async () => {
    const w = make();
    await w.writeNote("Health/a.md", "1");
    await w.writeNote("Health/b.md", "2");
    expect(fake.initializes).toBe(1);
  });

  it("認証失敗はトークンを含まないエラー", async () => {
    const bad = "wrong-token-abcdefghijklmnop";
    const w = make({ token: bad });
    const err = await w.writeNote("Health/a.md", "x").catch((e) => e);
    expect(err).toBeInstanceOf(VaultWriteError);
    expect(String(err.message)).not.toContain(bad);
    expect(String(err.message)).not.toContain(TOKEN);
    expect(fake.toolCalls).toBe(0);
  });

  it("権限エラーはリトライしない", async () => {
    const w = make({ prefix: "Other/" });
    await expect(w.writeNote("Other/a.md", "x")).rejects.toThrow(/Write access denied/);
    expect(fake.toolCalls).toBe(1);
  });

  it("Error で始まるテキストも失敗として扱い、やり直しても失敗すれば throw", async () => {
    await expect(make().writeNote("Health/boom.md", "x")).rejects.toThrow(/disk full/);
    expect(fake.toolCalls).toBe(4);
  });

  it("ツールの一時的なエラーはやり直して成功する（書き込み）", async () => {
    const w = make();
    fake.toolErrors = ["Tool 'write_note' execution failed: Database write layer error!"];
    await w.writeNote("Health/a.md", "x");
    expect(fake.notes.get("Health/a.md")).toBe("x");
    expect(fake.toolCalls).toBe(2);
    // ツールのエラーでは接続を張り直さない
    expect(fake.initializes).toBe(1);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.warn).mock.calls[0]?.[0]).toMatch(
      /write_note をやり直します（1\/3 回目）/,
    );
  });

  it("ツールの一時的なエラーはやり直して成功する（読み込み）", async () => {
    const w = make();
    await w.writeNote("Health/a.md", "本文");
    fake.toolErrors = ["Error: chunk not found", "Error: chunk not found"];
    expect(await w.readNote("Health/a.md")).toBe("本文");
    expect(console.warn).toHaveBeenCalledTimes(2);
  });

  it("やり直しのログにもトークンを出さない", async () => {
    const w = make();
    fake.toolErrors = [`Error: bad ${TOKEN}`];
    await w.writeNote("Health/a.md", "x");
    expect(String(vi.mocked(console.warn).mock.calls[0]?.[0])).not.toContain(TOKEN);
  });

  it("5xx はリトライして成功する", async () => {
    const w = make();
    await w.writeNote("Health/warm.md", "x");
    fake.failToolCalls = [503, 502];
    await w.writeNote("Health/a.md", "ok");
    expect(fake.notes.get("Health/a.md")).toBe("ok");
  });

  it("5xx が続けば 3 回リトライ後に失敗する", async () => {
    const w = make();
    fake.failToolCalls = [500, 500, 500, 500, 500];
    await expect(w.writeNote("Health/a.md", "x")).rejects.toThrow(VaultWriteError);
    expect(fake.failToolCalls).toHaveLength(1);
  });

  it("タイムアウトはリトライ対象", async () => {
    const w = make({ timeoutMs: 150 });
    await w.writeNote("Health/warm.md", "x");
    fake.toolDelayMs = 400;
    await expect(w.writeNote("Health/slow.md", "x")).rejects.toThrow(VaultWriteError);
    expect(fake.toolCalls).toBeGreaterThan(2);
  });

  it("セッション切れは再接続して 1 回やり直す", async () => {
    const w = make();
    await w.writeNote("Health/a.md", "1");
    fake.dropSessions();
    await w.writeNote("Health/b.md", "2");
    expect(fake.notes.get("Health/b.md")).toBe("2");
    expect(fake.initializes).toBe(2);
  });

  it.each([
    ["範囲外", "outside.md"],
    ["他フォルダ", "Healthy/a.md"],
    ["拡張子", "Health/a.txt"],
    ["..", "Health/../secret.md"],
    ["バックスラッシュ", "Health\\a.md"],
    ["先頭スラッシュ", "/Health/a.md"],
    ["ファイル名なし", "Health/"],
  ])("パスガード: %s", async (_n, path) => {
    const w = make();
    await expect(w.writeNote(path, "x")).rejects.toThrow(/不正な Vault パス/);
    await expect(w.readNote(path)).rejects.toThrow(/不正な Vault パス/);
    expect(fake.initializes).toBe(0);
  });

  it(".base も許可される", async () => {
    await make().writeNote("Health/views/x.base", "views: []");
    expect(fake.notes.has("Health/views/x.base")).toBe(true);
  });

  it("writeMany は失敗しても続行し、並列数を守る", async () => {
    const w = make();
    fake.toolDelayMs = 30;
    const items = Array.from({ length: 8 }, (_, i) => ({
      path: `Health/n${i}.md`,
      content: String(i),
    }));
    items.splice(3, 0, { path: "outside.md", content: "x" });
    items.splice(5, 0, { path: "Health/boom.md", content: "x" });
    const progress: number[] = [];
    const res = await w.writeMany(items, {
      concurrency: 2,
      onProgress: (done, total) => {
        progress.push(done);
        expect(total).toBe(10);
      },
    });
    expect(res.written).toBe(8);
    expect(res.failed.map((f) => f.path).sort()).toEqual(["Health/boom.md", "outside.md"]);
    expect(progress).toHaveLength(10);
    expect(fake.maxInflight).toBeLessThanOrEqual(2);
    expect(fake.maxInflight).toBeGreaterThan(1);
  });
});

describe("assertVaultPath", () => {
  it.each([
    "Health/Daily/2026-02-01.md",
    "Health/Monthly/2026-02.md",
    "Health/ヘルスケアダッシュボード.md",
    "Health/睡眠ダッシュボード.md",
    "Health/_bases/日次ログ.base",
    "Health/_bases/睡眠ログ.base",
    "Health/_bases/月次サマリー.base",
  ])("生成するノートのパス %s は通す", (path) => {
    expect(() => assertVaultPath(path, "Health/")).not.toThrow();
  });

  it.each([
    ["プレフィックスの外", "Other/a.md"],
    ["プレフィックスそのもの", "Health/"],
    ["拡張子が違う", "Health/a.txt"],
    ["親ディレクトリ", "Health/../a.md"],
    ["親ディレクトリ（末尾）", "Health/x/..md"],
    ["カレントディレクトリ", "Health/./a.md"],
    ["空のセグメント", "Health//a.md"],
    ["バックスラッシュ", "Health\\a.md"],
    ["絶対パス", "/Health/a.md"],
    ["改行", "Health/a\n.md"],
    ["ESC", "Health/\u001b[31ma.md"],
    ["NUL", "Health/a\u0000.md"],
    ["DEL", "Health/a\u007f.md"],
  ])("%s は拒否する", (_name, path) => {
    expect(() => assertVaultPath(path, "Health/")).toThrow(VaultPathError);
  });

  it("エラー文に制御文字をそのまま含めない", () => {
    const err = (() => {
      try {
        assertVaultPath("Health/\u001b[2Ja.md", "Health/");
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err).toBeInstanceOf(VaultWriteError);
    expect(err?.message).not.toContain("\u001b");
    expect(err?.message).toContain("\\u001b");
  });
});

describe("MemoryVaultWriter / writeMany", () => {
  it("同じパスガードで読み書きできる", async () => {
    const m = new MemoryVaultWriter();
    await m.writeNote("Health/a.md", "x");
    expect(await m.readNote("Health/a.md")).toBe("x");
    expect(await m.readNote("Health/b.md")).toBeNull();
    await expect(m.writeNote("a.md", "x")).rejects.toThrow(VaultWriteError);
  });

  it("writeMany は任意の VaultWriter で使える", async () => {
    const m: VaultWriter = new MemoryVaultWriter();
    const res = await writeMany(m, [
      { path: "Health/a.md", content: "1" },
      { path: "bad.md", content: "2" },
    ]);
    expect(res.written).toBe(1);
    expect(res.failed).toHaveLength(1);
  });
});

describe("config / createVaultWriter", () => {
  const base = {
    API_TOKEN: "a".repeat(32),
    COUCHDB_URL: "http://localhost:5984",
    COUCHDB_USER: "u",
    COUCHDB_PASSWORD: "p",
  };

  const writerOptions = (c: ReturnType<typeof loadConfig>) => ({
    url: c.OBSIDIAN_MCP_URL,
    token: c.OBSIDIAN_MCP_TOKEN,
    prefix: c.VAULT_HEALTH_PREFIX,
  });

  it("未設定なら null、prefix は既定値", () => {
    const c = loadConfig(base);
    expect(c.VAULT_HEALTH_PREFIX).toBe("Health/");
    expect(createVaultWriter(writerOptions(c))).toBeNull();
  });

  it("両方設定なら writer を返す", async () => {
    const c = loadConfig({
      ...base,
      OBSIDIAN_MCP_URL: "https://x.fly.dev/mcp",
      OBSIDIAN_MCP_TOKEN: "t".repeat(16),
    });
    const w = createVaultWriter(writerOptions(c));
    expect(w).toBeInstanceOf(McpVaultWriter);
    await w!.close();
  });

  it("createVaultWriter は URL かトークンが無ければ null", () => {
    const url = "https://x.fly.dev/mcp";
    const token = "t".repeat(16);
    expect(createVaultWriter({ url, token: undefined, prefix: "Health/" })).toBeNull();
    expect(createVaultWriter({ url: undefined, token, prefix: "Health/" })).toBeNull();
  });

  it("片方だけなら throw", () => {
    expect(() => loadConfig({ ...base, OBSIDIAN_MCP_URL: "https://x.fly.dev/mcp" })).toThrow(
      /OBSIDIAN_MCP_URL/,
    );
    expect(() => loadConfig({ ...base, OBSIDIAN_MCP_TOKEN: "t".repeat(16) })).toThrow(
      /OBSIDIAN_MCP/,
    );
  });

  it("トークンが短いと throw", () => {
    expect(() =>
      loadConfig({
        ...base,
        OBSIDIAN_MCP_URL: "https://x.fly.dev/mcp",
        OBSIDIAN_MCP_TOKEN: "short",
      }),
    ).toThrow();
  });
});
