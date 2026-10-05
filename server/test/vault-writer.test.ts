import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createVaultWriter } from "../src/vault/index.js";
import { McpVaultWriter } from "../src/vault/mcp-vault-writer.js";
import { MemoryVaultWriter } from "../src/vault/memory-vault-writer.js";
import { VaultWriteError, type VaultWriter, writeMany } from "../src/vault/vault-writer.js";
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
});
afterEach(async () => {
  await Promise.all(writers.splice(0).map((w) => w.close()));
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
  ])("ノート不在以外のエラー（%s）は null にせず throw", async (msg) => {
    fake.readResponses.set("Health/a.md", { text: msg, isError: true });
    const err = await make()
      .readNote("Health/a.md")
      .catch((e) => e);
    expect(err).toBeInstanceOf(VaultWriteError);
    expect(String(err.message)).toContain(msg);
    expect(fake.toolCalls).toBe(1);
  });

  it("isError でない応答の「Note not found」は null にしない", async () => {
    fake.readResponses.set("Health/a.md", { text: "Note not found: memo", isError: false });
    expect(await make().readNote("Health/a.md")).toBe("Note not found: memo");
  });

  it("isError 付きの「Note not found: <パス>」だけを不在とみなす", async () => {
    fake.readResponses.set("Health/Daily/2026-01-01.md", {
      text: "Note not found: Health/Daily/2026-01-01.md",
      isError: true,
    });
    expect(await make().readNote("Health/Daily/2026-01-01.md")).toBeNull();
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

  it("Error で始まるテキストも失敗として扱いリトライしない", async () => {
    await expect(make().writeNote("Health/boom.md", "x")).rejects.toThrow(/disk full/);
    expect(fake.toolCalls).toBe(1);
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

  it("未設定なら null、prefix は既定値", () => {
    const c = loadConfig(base);
    expect(c.VAULT_HEALTH_PREFIX).toBe("Health/");
    expect(createVaultWriter(c)).toBeNull();
  });

  it("両方設定なら writer を返す", async () => {
    const c = loadConfig({
      ...base,
      OBSIDIAN_MCP_URL: "https://x.fly.dev/mcp",
      OBSIDIAN_MCP_TOKEN: "t".repeat(16),
    });
    const w = createVaultWriter(c);
    expect(w).toBeInstanceOf(McpVaultWriter);
    await w!.close();
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
