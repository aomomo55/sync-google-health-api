import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { MemoryStore } from "../src/store/memory-store.js";
import { NoteSync } from "../src/sync/note-sync.js";
import { MemoryVaultWriter } from "../src/vault/memory-vault-writer.js";

const TOKEN = "t".repeat(32);
let app: ReturnType<typeof createApp>;

function call(path: string, body: unknown, auth = true) {
  return app.request(path, {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "Content-Type": "application/json",
      ...(auth ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
  });
}

const ingest = (body: unknown) => call("/api/ingest", body);
const oneDay = { days: [{ date: "2026-01-01", activity: { steps: 1 } }] };

function build(opts: { throwing?: boolean } = {}) {
  const store = new MemoryStore();
  const writer = new MemoryVaultWriter();
  const real = new NoteSync({ store, writer });
  const noteSync = opts.throwing
    ? ({
        syncDates: async () => {
          throw new Error("vault down");
        },
        syncRange: real.syncRange.bind(real),
      } as unknown as NoteSync)
    : real;
  app = createApp({ config: { API_TOKEN: TOKEN }, store, noteSync });
  return writer;
}

describe("POST /api/ingest（ノート同期）", () => {
  it("Vault 設定ありなら件数つきでノートを書く", async () => {
    const writer = build();
    const res = await ingest(oneDay);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      written: 1,
      notes: { written: 2, unchanged: 0, failed: [] },
    });
    expect(writer.notes.size).toBe(2);
  });

  it("noteSync が無ければ notes は null", async () => {
    app = createApp({ config: { API_TOKEN: TOKEN }, store: new MemoryStore() });
    const res = await ingest(oneDay);
    expect(await res.json()).toEqual({ written: 1, notes: null });
  });

  it("同期が例外を投げても 200 で error を返し、トークンは含まない", async () => {
    build({ throwing: true });
    const res = await ingest(oneDay);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { written: number; notes: { error: string } };
    expect(json.written).toBe(1);
    expect(json.notes.error).toBe("vault down");
    expect(JSON.stringify(json)).not.toContain(TOKEN);
  });
});

describe("POST /api/notes/sync", () => {
  beforeEach(() => {
    build();
  });

  it("認証なしは 401", async () => {
    expect((await call("/api/notes/sync", {}, false)).status).toBe(401);
  });

  it("Vault 未設定は 503", async () => {
    app = createApp({ config: { API_TOKEN: TOKEN }, store: new MemoryStore() });
    const res = await call("/api/notes/sync", { from: "2026-01-01", to: "2026-01-02" });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Vault が設定されていません" });
  });

  it.each([
    ["from 欠落", { to: "2026-01-02" }],
    ["不正な日付", { from: "2026-02-30", to: "2026-03-01" }],
    ["from > to", { from: "2026-01-03", to: "2026-01-02" }],
    ["401日", { from: "2025-01-01", to: "2026-02-05" }],
    ["未知キー", { from: "2026-01-01", to: "2026-01-02", x: 1 }],
    [
      "includeStatic が真偽値でない",
      { from: "2026-01-01", to: "2026-01-02", includeStatic: "yes" },
    ],
  ])("400: %s", async (_n, body) => {
    expect((await call("/api/notes/sync", body)).status).toBe(400);
  });

  it("範囲を同期して件数を返す", async () => {
    const writer = build();
    await ingest(oneDay);
    const res = await call("/api/notes/sync", {
      from: "2026-01-01",
      to: "2026-01-31",
      includeStatic: true,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ written: 5, unchanged: 2, failed: [] });
    expect(writer.notes.size).toBe(7);
  });
});
