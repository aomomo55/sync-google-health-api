import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { MemoryStore } from "../src/store/memory-store.js";

const BASE = {
  API_TOKEN: "t".repeat(32),
  COUCHDB_URL: "http://localhost:5984",
  COUCHDB_USER: "u",
  COUCHDB_PASSWORD: "p",
};

// loadConfig の例外メッセージを取り出す（値が含まれないことの確認用）
function errorOf(env: Record<string, string>): string {
  try {
    loadConfig(env);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("throw しなかった");
}

describe("COUCHDB_URL", () => {
  it("http / https のベース URL は受け付ける", () => {
    expect(loadConfig(BASE).COUCHDB_URL).toBe("http://localhost:5984");
    expect(loadConfig({ ...BASE, COUCHDB_URL: "https://couch.example.com" }).COUCHDB_URL).toBe(
      "https://couch.example.com",
    );
  });

  it("ユーザー名・パスワード入りの URL は拒否し、値をメッセージに出さない", () => {
    for (const url of [
      "http://admin:secret-pass-123@couch.example.com:5984",
      "https://admin@couch.example.com",
      "http://:secret-pass-123@couch.example.com",
    ]) {
      const msg = errorOf({ ...BASE, COUCHDB_URL: url });
      expect(msg).toMatch(/COUCHDB_URL/);
      expect(msg).toMatch(/COUCHDB_USER \/ COUCHDB_PASSWORD/);
      expect(msg).not.toContain("secret-pass-123");
      expect(msg).not.toContain("couch.example.com");
    }
  });

  it("http / https 以外のスキームは拒否する", () => {
    for (const url of ["file:///etc/passwd", "ftp://couch.example.com", "javascript:alert(1)"]) {
      const msg = errorOf({ ...BASE, COUCHDB_URL: url });
      expect(msg).toMatch(/COUCHDB_URL: http: または https:/);
      expect(msg).not.toContain(url);
    }
  });

  it("URL として解釈できない値は拒否し、値を出さない", () => {
    const msg = errorOf({ ...BASE, COUCHDB_URL: "not a url secret-xyz" });
    expect(msg).toMatch(/COUCHDB_URL/);
    expect(msg).not.toContain("secret-xyz");
  });
});

describe("API_TOKEN", () => {
  it("bearerAuth が受け付けない文字（! # : @ など）を含むと拒否し、値を出さない", () => {
    for (const ch of ["!", "#", ":", "@", "%", '"']) {
      const bad = `${"k".repeat(32)}${ch}`;
      const msg = errorOf({ ...BASE, API_TOKEN: bad });
      expect(msg).toMatch(/API_TOKEN/);
      expect(msg).not.toContain(bad);
    }
  });

  it("制御文字や空白は引き続き拒否する", () => {
    expect(() => loadConfig({ ...BASE, API_TOKEN: `\x1b[200~${"s".repeat(32)}` })).toThrow(
      /API_TOKEN/,
    );
    expect(() => loadConfig({ ...BASE, API_TOKEN: `${"s".repeat(16)} ${"s".repeat(16)}` })).toThrow(
      /API_TOKEN/,
    );
  });

  it("英数字と . _ ~ + / - と末尾の = は受け付ける", () => {
    const ok = `Ab0._~+/-${"x".repeat(24)}==`;
    expect(loadConfig({ ...BASE, API_TOKEN: ok }).API_TOKEN).toBe(ok);
    // = は末尾にだけ置ける
    expect(() => loadConfig({ ...BASE, API_TOKEN: `${"x".repeat(16)}=${"x".repeat(16)}` })).toThrow(
      /API_TOKEN/,
    );
  });

  it("設定で通ったトークンは bearerAuth でも認証できる", async () => {
    const token = `Ab0._~+/-${"x".repeat(24)}==`;
    const config = loadConfig({ ...BASE, API_TOKEN: token });
    const app = createApp({ config, store: new MemoryStore() });
    const res = await app.request("/api/ping", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
  });
});

describe("OBSIDIAN_MCP_URL", () => {
  const mcp = (url: string) => ({
    ...BASE,
    OBSIDIAN_MCP_URL: url,
    OBSIDIAN_MCP_TOKEN: "m".repeat(16),
  });

  it("https は受け付ける", () => {
    expect(loadConfig(mcp("https://mcp.example.com/mcp")).OBSIDIAN_MCP_URL).toBe(
      "https://mcp.example.com/mcp",
    );
  });

  it("http は localhost / 127.0.0.1 / [::1] だけ受け付ける", () => {
    for (const url of [
      "http://localhost:3000/mcp",
      "http://127.0.0.1:3000/mcp",
      "http://[::1]:3000/mcp",
    ]) {
      expect(loadConfig(mcp(url)).OBSIDIAN_MCP_URL).toBe(url);
    }
  });

  it("その他のホストへの http や他のスキームは拒否する", () => {
    for (const url of [
      "http://mcp.example.com/mcp",
      "http://192.168.0.10/mcp",
      "http://localhost.example.com/mcp",
      "ftp://mcp.example.com/mcp",
    ]) {
      expect(() => loadConfig(mcp(url))).toThrow(/OBSIDIAN_MCP_URL: https:/);
    }
  });
});

describe("VAULT_HEALTH_PREFIX", () => {
  it("既定値は Health/", () => {
    expect(loadConfig(BASE).VAULT_HEALTH_PREFIX).toBe("Health/");
  });

  it("文字・数字・空白・_・- のフォルダを / で区切ったものは受け付ける", () => {
    for (const prefix of ["Health", "Health/", "Life/Health_2", "健康 記録/日次-data/"]) {
      expect(loadConfig({ ...BASE, VAULT_HEALTH_PREFIX: prefix }).VAULT_HEALTH_PREFIX).toBe(prefix);
    }
  });

  it("引用符・記号・先頭の /・. や .. ・空のフォルダ名は拒否する", () => {
    for (const prefix of [
      "",
      "/Health/",
      "Health//Daily",
      "../Health",
      "Health/./x",
      "Health/..",
      ".obsidian/",
      'Health"/',
      "Health'/",
      "Health`/",
      "Health\\",
      "Health/a.md",
      "Health\n",
    ]) {
      expect(() => loadConfig({ ...BASE, VAULT_HEALTH_PREFIX: prefix })).toThrow(
        /VAULT_HEALTH_PREFIX/,
      );
    }
  });
});
