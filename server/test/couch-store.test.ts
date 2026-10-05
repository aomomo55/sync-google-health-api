import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CouchStore } from "../src/store/couch-store.js";
import { NoteSync } from "../src/sync/note-sync.js";
import { MemoryVaultWriter } from "../src/vault/memory-vault-writer.js";

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
  it("ensureReady は DB があれば作成しない（DB 専用ユーザーで動かせる）", async () => {
    const { store, calls } = make([{ status: 200, json: { db_name: "health" } }]);
    await store.ensureReady();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "GET", url: "http://couch.test:5984/health" });
    expect(calls[0]?.headers.Authorization).toBe(AUTH);
  });

  it.each([201, 202, 412])("ensureReady は DB が無ければ作成し、%i を許容", async (status) => {
    const { store, calls } = make([{ status: 404, json: { error: "not_found" } }, { status }]);
    await store.ensureReady();
    expect(calls[1]).toMatchObject({ method: "PUT", url: "http://couch.test:5984/health" });
  });

  it("ensureReady は DB が無く作成権限も無いと、分かるメッセージで throw する", async () => {
    const { store } = make([{ status: 404, json: { error: "not_found" } }, { status: 401 }]);
    const err = await store.ensureReady().then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toContain("管理者で作成してください");
    expect(err?.message).not.toContain(PASSWORD);
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

  it("接続できないときも認証情報をエラー文に含めない", async () => {
    const store = new CouchStore({
      baseUrl: "http://couch.test:5984",
      user: "admin",
      password: PASSWORD,
      db: "health",
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });
    const err = await store.findAdjacentDate("2026-01-01", "prev").then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toContain("接続できません");
    expect(err?.message).not.toContain(PASSWORD);
    expect(err?.message).not.toContain("startkey");
  });
});

// _all_docs の startkey / endkey / descending / limit だけを解釈する偽の CouchDB
function fakeCouch(docs: Record<string, unknown>[]) {
  return (async (url: string | URL | Request) => {
    const u = new URL(String(url));
    const param = (k: string) => {
      const v = u.searchParams.get(k);
      return v === null ? undefined : (JSON.parse(v) as string);
    };
    const start = param("startkey") ?? "";
    const end = param("endkey") ?? "\uffff";
    const descending = u.searchParams.get("descending") === "true";
    const limit = Number(u.searchParams.get("limit") ?? Number.POSITIVE_INFINITY);
    const ids = docs.map((d) => String(d._id)).sort();
    const inRange = descending
      ? ids.filter((id) => id <= start && id >= end).reverse()
      : ids.filter((id) => id >= start && id <= end);
    const withDocs = u.searchParams.get("include_docs") === "true";
    const rows = inRange.slice(0, limit).map((id) => ({
      id,
      ...(withDocs ? { doc: docs.find((d) => d._id === id) } : {}),
    }));
    return new Response(JSON.stringify({ rows }), { status: 200 });
  }) as typeof fetch;
}

describe("CouchStore が読む文書の日付（_id を正とする）", () => {
  const meta = (id: string) => ({ _id: id, _rev: "1-a", type: "daily", updated_at: "x" });
  const docs = [
    { ...meta("day:2026-01-01"), date: "2026-01-01", activity: { steps: 1 } },
    // date が無い
    { ...meta("day:2026-01-02"), activity: { steps: 2 } },
    // _id と date が食い違う
    { ...meta("day:2026-01-03"), date: "2026-01-09", activity: { steps: 3 } },
    // date が文字列でない
    { ...meta("day:2026-01-05"), date: 20260105, activity: { steps: 5 } },
    { ...meta("day:2026-01-04"), date: "2026-01-04", activity: { steps: 4 } },
  ];
  const makeStore = () =>
    new CouchStore({
      baseUrl: "http://couch.test:5984",
      user: "admin",
      password: PASSWORD,
      db: "health",
      fetch: fakeCouch(docs),
    });

  it("getDays は落ちずに _id の順で返し、不正な文書の date には _id を入れる", async () => {
    const days = await makeStore().getDays("2026-01-01", "2026-01-31");
    expect(days.map((d) => d.date)).toEqual([
      "2026-01-01",
      "day:2026-01-02",
      "day:2026-01-03",
      "2026-01-04",
      "day:2026-01-05",
    ]);
    expect(days[2]).toEqual({ date: "day:2026-01-03", activity: { steps: 3 } });
  });

  it("NoteSync は不正な文書を failed に載せ、有効な日だけノートを書く", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const writer = new MemoryVaultWriter();
      const sync = new NoteSync({ store: makeStore(), writer });
      const report = await sync.syncRange("2026-01-01", "2026-01-31");
      expect(report.failed.map((f) => f.path)).toEqual([
        '日付 "day:2026-01-02"',
        '日付 "day:2026-01-03"',
        '日付 "day:2026-01-05"',
      ]);
      const daily = [...writer.notes.keys()].filter((p) => /\d{4}-\d{2}-\d{2}\.md$/.test(p));
      expect(daily.map((p) => p.match(/(\d{4}-\d{2}-\d{2})\.md$/)?.[1]).sort()).toEqual([
        "2026-01-01",
        "2026-01-04",
      ]);
      // 不正な日を飛ばして前後がつながる
      const first = writer.notes.get(daily.find((p) => p.endsWith("2026-01-01.md"))!);
      expect(first).toContain("2026-01-04");
      expect(first).not.toContain("2026-01-09");
    } finally {
      errorLog.mockRestore();
    }
  });
});

describe("CouchStore のタイムアウト", () => {
  // 接続は受け付けるが応答を返さないサーバー
  const server = createServer(() => {});
  let baseUrl = "";

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it("応答が無ければ timeoutMs で打ち切り、認証情報を含まないエラーにする", async () => {
    const store = new CouchStore({
      baseUrl,
      user: "admin",
      password: PASSWORD,
      db: "health",
      timeoutMs: 100,
    });
    const started = Date.now();
    const err = await store.getDays("2026-01-01", "2026-01-31").then(
      () => null,
      (e: Error) => e,
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(err?.message).toBe("CouchDB GET /_all_docs がタイムアウトしました（100 ms）");
    expect(err?.message).not.toContain(PASSWORD);
    expect(err?.message).not.toContain(AUTH);
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
