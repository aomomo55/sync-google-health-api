import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { MemoryStore } from "../src/store/memory-store.js";

const TOKEN = "t".repeat(32);
const app = createApp({
  config: { API_TOKEN: TOKEN },
  store: new MemoryStore(),
});
const COUCH = {
  COUCHDB_URL: "http://localhost:5984",
  COUCHDB_USER: "u",
  COUCHDB_PASSWORD: "p",
};

describe("app", () => {
  it("GET /healthz は認証なしで 200", async () => {
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("/api/ping はトークンなしで 401", async () => {
    const res = await app.request("/api/ping");
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toMatch(/^Bearer/);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("/api/ping は誤ったトークンで 401", async () => {
    const res = await app.request("/api/ping", {
      headers: { Authorization: `Bearer ${"x".repeat(32)}` },
    });
    expect(res.status).toBe(401);
  });

  it("/api/ping は正しいトークンで 200", async () => {
    const res = await app.request("/api/ping", {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pong: true });
  });

  it("未知のルートは JSON の 404", async () => {
    const res = await app.request("/nope");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: "Not Found" });
  });
});

describe("loadConfig", () => {
  it("API_TOKEN が無いと throw", () => {
    expect(() => loadConfig({ ...COUCH })).toThrow(/API_TOKEN/);
  });

  it("API_TOKEN が短いと throw", () => {
    expect(() => loadConfig({ ...COUCH, API_TOKEN: "short" })).toThrow(/API_TOKEN/);
  });

  it("PORT のデフォルトは 8080", () => {
    expect(loadConfig({ ...COUCH, API_TOKEN: TOKEN }).PORT).toBe(8080);
  });

  it("COUCHDB_* が無いと throw", () => {
    expect(() => loadConfig({ API_TOKEN: TOKEN })).toThrow(/COUCHDB_URL/);
  });

  it("トークンに制御文字（貼り付け時の ESC など）があると throw し、値は出さない", () => {
    const bad = `\x1b[200~${"s".repeat(32)}`;
    const run = () =>
      loadConfig({
        ...COUCH,
        API_TOKEN: TOKEN,
        OBSIDIAN_MCP_URL: "https://example.com/mcp",
        OBSIDIAN_MCP_TOKEN: bad,
      });
    expect(run).toThrow(/OBSIDIAN_MCP_TOKEN/);
    expect(run).not.toThrow(/sssss/);
    expect(() => loadConfig({ ...COUCH, API_TOKEN: `${TOKEN}\r` })).toThrow(/API_TOKEN/);
  });

  it("CouchDB のパスワードは空白を許し、改行は拒否する", () => {
    expect(
      loadConfig({ ...COUCH, COUCHDB_PASSWORD: "pass word", API_TOKEN: TOKEN }).COUCHDB_PASSWORD,
    ).toBe("pass word");
    expect(() => loadConfig({ ...COUCH, COUCHDB_PASSWORD: "pass\n", API_TOKEN: TOKEN })).toThrow(
      /COUCHDB_PASSWORD/,
    );
  });

  it("COUCHDB_HEALTH_DB のデフォルトは health", () => {
    expect(loadConfig({ ...COUCH, API_TOKEN: TOKEN }).COUCHDB_HEALTH_DB).toBe("health");
  });
});
