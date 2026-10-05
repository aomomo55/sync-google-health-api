import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

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
