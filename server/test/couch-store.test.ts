import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CouchStore } from "../src/store/couch-store.js";

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

function fakeFetch(responses: { status: number; json?: unknown }[]) {
  const calls: Call[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers: init?.headers as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const r = responses.shift();
    if (!r) throw new Error("unexpected request");
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status });
  }) as typeof fetch;
  return { fn, calls };
}

const PASSWORD = "s3cret-pw";
const AUTH = `Basic ${Buffer.from(`admin:${PASSWORD}`).toString("base64")}`;

function make(responses: { status: number; json?: unknown }[]) {
  const f = fakeFetch(responses);
  const store = new CouchStore({
    baseUrl: "http://couch.test:5984/",
    user: "admin",
    password: PASSWORD,
    db: "health",
    fetch: f.fn,
  });
  return { store, calls: f.calls };
}

describe("CouchStore (fake fetch)", () => {
  it.each([201, 202, 412])("ensureReady は %i を許容", async (status) => {
    const { store, calls } = make([{ status }]);
    await store.ensureReady();
    expect(calls[0]).toMatchObject({ method: "PUT", url: "http://couch.test:5984/health" });
    expect(calls[0]?.headers.Authorization).toBe(AUTH);
  });

  it("ensureReady の 401 は throw し、パスワードを含まない", async () => {
    const { store } = make([{ status: 401 }]);
    const err = await store.ensureReady().then(
      () => null,
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toContain("401");
    expect(err?.message).not.toContain(PASSWORD);
    expect(err?.message).not.toContain(Buffer.from(`admin:${PASSWORD}`).toString("base64"));
  });

  it("getDays は正しい URL で、メタ情報を除いて返す", async () => {
    const { store, calls } = make([
      {
        status: 200,
        json: {
          rows: [
            {
              id: "day:2026-01-02",
              doc: {
                _id: "day:2026-01-02",
                _rev: "1-a",
                type: "daily",
                updated_at: "x",
                date: "2026-01-02",
                body: { weight_kg: 1 },
              },
            },
            {
              id: "day:2026-01-01",
              doc: {
                _id: "day:2026-01-01",
                _rev: "1-b",
                type: "daily",
                updated_at: "x",
                date: "2026-01-01",
              },
            },
            { id: "day:2026-01-03", value: { deleted: true }, doc: null },
          ],
        },
      },
    ]);
    const days = await store.getDays("2026-01-01", "2026-01-03");
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe(
      "http://couch.test:5984/health/_all_docs?include_docs=true" +
        `&startkey=${encodeURIComponent('"day:2026-01-01"')}&endkey=${encodeURIComponent('"day:2026-01-03"')}`,
    );
    expect(days).toEqual([{ date: "2026-01-01" }, { date: "2026-01-02", body: { weight_kg: 1 } }]);
  });

  it("upsertDays は既存とマージして _bulk_docs に送る", async () => {
    const { store, calls } = make([
      {
        status: 200,
        json: {
          rows: [
            {
              id: "day:2026-01-01",
              doc: {
                _id: "day:2026-01-01",
                _rev: "3-x",
                type: "daily",
                updated_at: "old",
                date: "2026-01-01",
                activity: { steps: 1, distance_m: 5 },
                source: "takeout",
              },
            },
            { key: "day:2026-01-02", error: "not_found" },
          ],
        },
      },
      {
        status: 201,
        json: [
          { ok: true, id: "day:2026-01-01", rev: "4-y" },
          { ok: true, id: "day:2026-01-02", rev: "1-z" },
        ],
      },
    ]);
    const r = await store.upsertDays([
      { date: "2026-01-01", activity: { steps: 9, distance_m: null }, source: "health_connect" },
      { date: "2026-01-02", body: { weight_kg: 60 } },
    ]);
    expect(r).toEqual({ written: 2 });
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: "http://couch.test:5984/health/_all_docs?include_docs=true",
      body: { keys: ["day:2026-01-01", "day:2026-01-02"] },
    });
    expect(calls[1]?.method).toBe("POST");
    expect(calls[1]?.url).toBe("http://couch.test:5984/health/_bulk_docs");
    expect(calls[1]?.headers.Authorization).toBe(AUTH);
    const bulk = calls[1]?.body as { docs: Record<string, unknown>[] };
    const docs = bulk.docs;
    expect(docs[0]).toMatchObject({
      _id: "day:2026-01-01",
      _rev: "3-x",
      type: "daily",
      date: "2026-01-01",
      activity: { steps: 9, distance_m: null },
      source: "health_connect",
    });
    expect(typeof docs[0]?.updated_at).toBe("string");
    expect(docs[1]).toMatchObject({
      _id: "day:2026-01-02",
      type: "daily",
      body: { weight_kg: 60 },
    });
    expect(docs[1]).not.toHaveProperty("_rev");
  });

  it("conflict は再読込して再試行する", async () => {
    const row = (rev: string) => ({
      rows: [
        {
          id: "day:2026-01-01",
          doc: {
            _id: "day:2026-01-01",
            _rev: rev,
            type: "daily",
            updated_at: "o",
            date: "2026-01-01",
          },
        },
      ],
    });
    const { store, calls } = make([
      { status: 200, json: row("1-a") },
      { status: 201, json: [{ id: "day:2026-01-01", error: "conflict", reason: "x" }] },
      { status: 200, json: row("2-b") },
      { status: 201, json: [{ ok: true, id: "day:2026-01-01", rev: "3-c" }] },
    ]);
    expect(await store.upsertDays([{ date: "2026-01-01", body: { weight_kg: 1 } }])).toEqual({
      written: 1,
    });
    expect(calls).toHaveLength(4);
    const retriedBody = calls[3]?.body as { docs: { _rev: string }[] };
    const retried = retriedBody.docs[0];
    expect(retried?._rev).toBe("2-b");
  });

  it("conflict が続けば最大3回の再試行後に throw", async () => {
    const rows = { status: 200, json: { rows: [] } };
    const conflict = { status: 201, json: [{ id: "day:2026-01-01", error: "conflict" }] };
    const { store, calls } = make([rows, conflict, rows, conflict, rows, conflict, rows, conflict]);
    await expect(store.upsertDays([{ date: "2026-01-01" }])).rejects.toThrow(/競合/);
    expect(calls).toHaveLength(8);
  });

  it("conflict 以外のエラーは throw", async () => {
    const { store } = make([
      { status: 200, json: { rows: [] } },
      { status: 201, json: [{ id: "day:2026-01-01", error: "forbidden" }] },
    ]);
    await expect(store.upsertDays([{ date: "2026-01-01" }])).rejects.toThrow(/forbidden/);
  });

  it("HTTP エラーは throw し、パスワードを含まない", async () => {
    const { store } = make([{ status: 500 }]);
    const err = await store.getDays("2026-01-01", "2026-01-02").then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toContain("500");
    expect(err?.message).not.toContain(PASSWORD);
  });
});

const TEST_URL = process.env.COUCHDB_TEST_URL;

describe.skipIf(!TEST_URL)("CouchStore (実 CouchDB 統合)", () => {
  const dbName = `health_test_${Date.now()}`;
  let base = "";
  let auth = "";
  let store: CouchStore;

  beforeAll(async () => {
    const u = new URL(TEST_URL as string);
    const user = decodeURIComponent(u.username);
    const password = decodeURIComponent(u.password);
    u.username = "";
    u.password = "";
    base = u.toString().replace(/\/+$/, "");
    auth = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
    store = new CouchStore({ baseUrl: base, user, password, db: dbName });
    await store.ensureReady();
  });

  afterAll(async () => {
    if (!base) return;
    await fetch(`${base}/${dbName}`, { method: "DELETE", headers: { Authorization: auth } });
  });

  it("ensureReady は冪等", async () => {
    await expect(store.ensureReady()).resolves.toBeUndefined();
  });

  it("findAdjacentDate は自身を除いた前後の日を返す", async () => {
    // 他のテストと日付が重ならないよう 2024 年を使う
    await store.upsertDays([
      { date: "2024-01-10", activity: { steps: 1 } },
      { date: "2024-08-01", activity: { steps: 2 } },
      { date: "2024-08-02", activity: { steps: 3 } },
    ]);
    expect(await store.findAdjacentDate("2024-08-01", "prev")).toBe("2024-01-10");
    expect(await store.findAdjacentDate("2024-01-10", "next")).toBe("2024-08-01");
    expect(await store.findAdjacentDate("2024-03-01", "next")).toBe("2024-08-01");
    expect(await store.findAdjacentDate("2024-01-10", "prev")).toBeNull();
    expect(await store.findAdjacentDate("2024-08-02", "next")).toBeNull();
  });

  it("upsert → マージ → 範囲取得", async () => {
    expect(
      await store.upsertDays([
        { date: "2026-01-02", body: { weight_kg: 60 } },
        { date: "2026-01-01", activity: { steps: 100, distance_m: 50 }, source: "takeout" },
        { date: "2026-02-01", activity: { steps: 1 } },
      ]),
    ).toEqual({ written: 3 });
    await store.upsertDays([
      { date: "2026-01-01", activity: { steps: 200, distance_m: null }, source: "health_connect" },
    ]);
    expect(await store.getDays("2026-01-01", "2026-01-31")).toEqual([
      { date: "2026-01-01", activity: { steps: 200, distance_m: null }, source: "health_connect" },
      { date: "2026-01-02", body: { weight_kg: 60 } },
    ]);
    expect(await store.getDays("2025-01-01", "2025-12-31")).toEqual([]);
  });
});
