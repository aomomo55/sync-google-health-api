import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RoomReading } from "../src/domain/room.js";
import { CouchStore } from "../src/store/couch-store.js";
import { MemoryStore } from "../src/store/memory-store.js";

const reading = (time: string, t = 20, h = 50): RoomReading => ({
  time,
  temperature_c: t,
  humidity_pct: h,
});

describe("MemoryStore の温湿度", () => {
  it("送り直しでは変わらなかった分を unchanged に数える", async () => {
    const store = new MemoryStore();
    const batch = [reading("2026-03-01T00:00:00Z"), reading("2026-03-01T00:30:00Z")];
    expect(await store.upsertReadings(batch)).toEqual({ written: 2, unchanged: 0 });
    expect(await store.upsertReadings(batch)).toEqual({ written: 0, unchanged: 2 });
    expect(
      await store.upsertReadings([
        reading("2026-03-01T00:00:00Z", 21, 50),
        reading("2026-03-01T01:00:00Z"),
      ]),
    ).toEqual({ written: 2, unchanged: 0 });
  });

  it("同じ分の値が同じ送信に複数あれば 1 件として数える", async () => {
    const store = new MemoryStore();
    expect(
      await store.upsertReadings([
        reading("2026-03-01T00:00:10Z", 20),
        reading("2026-03-01T00:00:40Z", 21),
      ]),
    ).toEqual({ written: 1, unchanged: 0 });
    expect(await store.getReadings("2026-03-01", "2026-03-01")).toEqual([
      reading("2026-03-01T09:00:00+09:00", 21),
    ]);
  });

  it("範囲は両端を含み、時刻の昇順で返す", async () => {
    const store = new MemoryStore();
    await store.upsertReadings([
      reading("2026-03-03T03:00:00Z"),
      reading("2026-03-01T03:00:00Z"),
      reading("2026-03-02T03:00:00Z"),
      reading("2026-03-02T01:00:00Z"),
      reading("2026-03-04T03:00:00Z"),
    ]);
    const got = await store.getReadings("2026-03-02", "2026-03-03");
    expect(got.map((r) => r.time)).toEqual([
      "2026-03-02T10:00:00+09:00",
      "2026-03-02T12:00:00+09:00",
      "2026-03-03T12:00:00+09:00",
    ]);
  });

  it("日付は Asia/Tokyo で分ける", async () => {
    const store = new MemoryStore();
    await store.upsertReadings([reading("2026-03-01T14:59:00Z"), reading("2026-03-01T15:00:00Z")]);
    expect((await store.getReadings("2026-03-01", "2026-03-01")).map((r) => r.time)).toEqual([
      "2026-03-01T23:59:00+09:00",
    ]);
    expect((await store.getReadings("2026-03-02", "2026-03-02")).map((r) => r.time)).toEqual([
      "2026-03-02T00:00:00+09:00",
    ]);
  });

  it("データが無い範囲は空", async () => {
    expect(await new MemoryStore().getReadings("2026-03-01", "2026-03-31")).toEqual([]);
  });
});

type Call = { url: string; method: string; body: unknown };
type FakeResponse = { status: number; json?: unknown };

function fakeFetch(responses: FakeResponse[]) {
  const calls: Call[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const r = responses.shift();
    if (!r) throw new Error("unexpected request");
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status });
  }) as typeof fetch;
  return { fn, calls };
}

function make(responses: FakeResponse[]) {
  const f = fakeFetch(responses);
  const store = new CouchStore({
    baseUrl: "http://couch.test:5984",
    user: "admin",
    password: "s3cret-pw",
    db: "health",
    fetch: f.fn,
  });
  return { store, calls: f.calls };
}

type SentDoc = {
  _id: string;
  _rev?: string;
  type: string;
  date: string;
  readings: { time: string; temperature_c: number; humidity_pct: number }[];
};
const sentDocs = (c: Call | undefined) => ((c?.body ?? { docs: [] }) as { docs: SentDoc[] }).docs;

const roomDoc = (date: string, readings: SentDoc["readings"], rev = "1-a") => ({
  _id: `room:${date}`,
  _rev: rev,
  type: "room",
  date,
  readings,
  updated_at: "2026-01-01T00:00:00.000Z",
});
const rowOf = (doc: unknown) => ({ doc });

describe("CouchStore の温湿度（fake fetch）", () => {
  it("新しい日は room:YYYY-MM-DD の文書として書く", async () => {
    const { store, calls } = make([
      { status: 200, json: { rows: [{ key: "room:2026-03-01", error: "not_found" }] } },
      { status: 201, json: [{ ok: true, id: "room:2026-03-01", rev: "1-x" }] },
    ]);
    const r = await store.upsertReadings([
      reading("2026-03-01T00:30:00Z", 19.5, 40),
      reading("2026-03-01T00:00:00Z", 20, 41),
    ]);
    expect(r).toEqual({ written: 2, unchanged: 0 });
    expect(calls[0]).toMatchObject({
      method: "POST",
      body: { keys: ["room:2026-03-01"] },
    });
    const docs = sentDocs(calls[1]);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ _id: "room:2026-03-01", type: "room", date: "2026-03-01" });
    expect(docs[0]?._rev).toBeUndefined();
    expect(docs[0]?.readings).toEqual([
      { time: "09:00", temperature_c: 20, humidity_pct: 41 },
      { time: "09:30", temperature_c: 19.5, humidity_pct: 40 },
    ]);
  });

  it("変わらない日は書き込まず、変わった日だけ既存の _rev つきで書く", async () => {
    const same = [{ time: "09:00", temperature_c: 20, humidity_pct: 50 }];
    const old = [{ time: "09:00", temperature_c: 20, humidity_pct: 50 }];
    const { store, calls } = make([
      {
        status: 200,
        json: {
          rows: [rowOf(roomDoc("2026-03-01", same)), rowOf(roomDoc("2026-03-02", old, "3-c"))],
        },
      },
      { status: 201, json: [{ ok: true, id: "room:2026-03-02", rev: "4-d" }] },
    ]);
    const r = await store.upsertReadings([
      reading("2026-03-01T00:00:00Z", 20, 50),
      reading("2026-03-02T00:00:00Z", 21, 50),
      reading("2026-03-02T00:30:00Z", 21, 50),
    ]);
    expect(r).toEqual({ written: 2, unchanged: 1 });
    const docs = sentDocs(calls[1]);
    expect(docs.map((d) => d._id)).toEqual(["room:2026-03-02"]);
    expect(docs[0]?._rev).toBe("3-c");
    expect(docs[0]?.readings).toHaveLength(2);
  });

  it("全て変わらなければ _bulk_docs を呼ばない", async () => {
    const same = [{ time: "09:00", temperature_c: 20, humidity_pct: 50 }];
    const { store, calls } = make([
      { status: 200, json: { rows: [rowOf(roomDoc("2026-03-01", same))] } },
    ]);
    expect(await store.upsertReadings([reading("2026-03-01T00:00:00Z", 20, 50)])).toEqual({
      written: 0,
      unchanged: 1,
    });
    expect(calls).toHaveLength(1);
  });

  it("競合した日だけを読み直して再送する", async () => {
    const { store, calls } = make([
      { status: 200, json: { rows: [] } },
      {
        status: 201,
        json: [
          { ok: true, id: "room:2026-03-01", rev: "1-a" },
          { id: "room:2026-03-02", error: "conflict", reason: "Document update conflict." },
        ],
      },
      {
        status: 200,
        json: {
          rows: [
            rowOf(
              roomDoc(
                "2026-03-02",
                [{ time: "10:00", temperature_c: 18, humidity_pct: 45 }],
                "1-b",
              ),
            ),
          ],
        },
      },
      { status: 201, json: [{ ok: true, id: "room:2026-03-02", rev: "2-c" }] },
    ]);
    const r = await store.upsertReadings([
      reading("2026-03-01T00:00:00Z"),
      reading("2026-03-02T00:00:00Z"),
    ]);
    expect(r).toEqual({ written: 2, unchanged: 0 });
    expect(calls).toHaveLength(4);
    expect(calls[2]?.body).toEqual({ keys: ["room:2026-03-02"] });
    const retried = sentDocs(calls[3]);
    expect(retried[0]?._rev).toBe("1-b");
    // 既存の 10:00 の値を残し、新しい 09:00 を足す
    expect(retried[0]?.readings.map((s) => s.time)).toEqual(["09:00", "10:00"]);
  });

  it("競合し続けたら throw する", async () => {
    const conflict = { status: 201, json: [{ id: "room:2026-03-01", error: "conflict" }] };
    const lookup = { status: 200, json: { rows: [] } };
    const { store } = make([
      lookup,
      conflict,
      lookup,
      conflict,
      lookup,
      conflict,
      lookup,
      conflict,
    ]);
    await expect(store.upsertReadings([reading("2026-03-01T00:00:00Z")])).rejects.toThrow(
      /競合し続けました/,
    );
  });

  it("conflict 以外の書き込みエラーは throw する", async () => {
    const { store } = make([
      { status: 200, json: { rows: [] } },
      { status: 201, json: [{ id: "room:2026-03-01", error: "forbidden" }] },
    ]);
    await expect(store.upsertReadings([reading("2026-03-01T00:00:00Z")])).rejects.toThrow(
      /forbidden/,
    );
  });

  it("既存の文書の形が不正なら throw する", async () => {
    const bad = { ...roomDoc("2026-03-01", []), readings: "oops" };
    const { store } = make([{ status: 200, json: { rows: [rowOf(bad)] } }]);
    await expect(store.upsertReadings([reading("2026-03-01T00:00:00Z")])).rejects.toThrow(
      /形が不正/,
    );
  });

  it("getReadings は _id の範囲で取得し、日付と時刻の昇順に並べる", async () => {
    const { store, calls } = make([
      {
        status: 200,
        json: {
          rows: [
            rowOf(
              roomDoc("2026-03-02", [
                { time: "00:30", temperature_c: 18, humidity_pct: 49 },
                { time: "01:00", temperature_c: 19, humidity_pct: 50 },
              ]),
            ),
            rowOf(roomDoc("2026-03-01", [{ time: "23:00", temperature_c: 20, humidity_pct: 51 }])),
            { id: "room:2026-03-03", value: { deleted: true }, doc: null },
          ],
        },
      },
    ]);
    const got = await store.getReadings("2026-03-01", "2026-03-03");
    expect(calls[0]?.url).toContain("startkey=%22room%3A2026-03-01%22");
    expect(calls[0]?.url).toContain("endkey=%22room%3A2026-03-03%22");
    expect(got.map((r) => r.time)).toEqual([
      "2026-03-01T23:00:00+09:00",
      "2026-03-02T00:30:00+09:00",
      "2026-03-02T01:00:00+09:00",
    ]);
  });

  it("getReadings は形が不正な文書を拒否し、文書の中身を含めない", async () => {
    const bad = roomDoc("2026-03-01", [{ time: "9:00", temperature_c: 20, humidity_pct: 50 }]);
    const { store } = make([{ status: 200, json: { rows: [rowOf(bad)] } }]);
    const err = await store.getReadings("2026-03-01", "2026-03-01").then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toContain("room:2026-03-01");
    expect(err?.message).not.toContain("9:00");
  });

  it.each([
    ["範囲外の時刻", "2026-03-01", "25:00"],
    ["実在しない日付", "2026-02-30", "01:30"],
  ])("getReadings は%sの文書を拒否する", async (_label, date, time) => {
    const bad = roomDoc(date, [{ time, temperature_c: 20, humidity_pct: 50 }]);
    const { store } = make([{ status: 200, json: { rows: [rowOf(bad)] } }]);
    await expect(store.getReadings("2026-02-01", "2026-03-31")).rejects.toThrow(`room:${date}`);
  });
});

const TEST_URL = process.env.COUCHDB_TEST_URL;

describe.skipIf(!TEST_URL)("CouchStore の温湿度（実 CouchDB 統合）", () => {
  const dbName = `health_room_test_${Date.now()}`;
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

  it("upsert → 送り直し → 範囲取得", async () => {
    const batch = [
      reading("2026-03-01T14:59:00Z", 20, 50),
      reading("2026-03-01T15:00:00Z", 21, 51),
      reading("2026-03-02T03:00:00Z", 22, 52),
    ];
    expect(await store.upsertReadings(batch)).toEqual({ written: 3, unchanged: 0 });
    expect(await store.upsertReadings(batch)).toEqual({ written: 0, unchanged: 3 });
    expect(await store.getReadings("2026-03-01", "2026-03-01")).toEqual([
      reading("2026-03-01T23:59:00+09:00", 20, 50),
    ]);
    expect((await store.getReadings("2026-03-01", "2026-03-02")).map((r) => r.time)).toEqual([
      "2026-03-01T23:59:00+09:00",
      "2026-03-02T00:00:00+09:00",
      "2026-03-02T12:00:00+09:00",
    ]);
  });
});
