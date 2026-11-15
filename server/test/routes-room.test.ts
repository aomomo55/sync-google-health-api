import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { MAX_ROOM_READINGS } from "../src/routes/room.js";
import { MemoryStore } from "../src/store/memory-store.js";

const API_TOKEN = "a".repeat(32);
const ROOM_TOKEN = "r".repeat(32);

const reading = (time = "2026-03-01T00:00:00Z", t = 20, h = 50) => ({
  time,
  temperature_c: t,
  humidity_pct: h,
});

function setup(roomToken: string | null = ROOM_TOKEN) {
  const store = new MemoryStore();
  const app = createApp({ config: { API_TOKEN, ROOM_TOKEN: roomToken ?? undefined }, store });
  const post = (body: string, token: string | null = ROOM_TOKEN) =>
    app.request("/room/readings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body,
    });
  return { app, store, post };
}

describe("ROOM_TOKEN 未設定", () => {
  it("/room/readings の経路を作らず 404", async () => {
    const { post } = setup(null);
    const res = await post(JSON.stringify({ readings: [reading()] }), API_TOKEN);
    expect(res.status).toBe(404);
  });
});

describe("/room の認証", () => {
  it("トークンなしは 401", async () => {
    const { post } = setup();
    const res = await post(JSON.stringify({ readings: [reading()] }), null);
    expect(res.status).toBe(401);
  });

  it("誤ったトークンは 401", async () => {
    const { post } = setup();
    const res = await post(JSON.stringify({ readings: [reading()] }), "x".repeat(32));
    expect(res.status).toBe(401);
  });

  it("API_TOKEN では /room を使えない", async () => {
    const { post, store } = setup();
    const res = await post(JSON.stringify({ readings: [reading()] }), API_TOKEN);
    expect(res.status).toBe(401);
    expect(await store.getReadings("2026-03-01", "2026-03-01")).toEqual([]);
  });

  it("ROOM_TOKEN では /api を使えない", async () => {
    const { app } = setup();
    const res = await app.request("/api/ping", {
      headers: { Authorization: `Bearer ${ROOM_TOKEN}` },
    });
    expect(res.status).toBe(401);
  });
});

describe("POST /room/readings", () => {
  it.each([
    ["ルートの未知キー", { readings: [reading()], extra: 1 }],
    ["読み取り値の未知キー", { readings: [{ ...reading(), extra: 1 }] }],
    ["readings が無い", {}],
    ["空配列", { readings: [] }],
    ["オフセット無しの時刻", { readings: [reading("2026-03-01T00:00:00")] }],
    ["時刻が日時でない", { readings: [reading("yesterday")] }],
    ["気温が低すぎる", { readings: [reading(undefined, -41, 50)] }],
    ["気温が高すぎる", { readings: [reading(undefined, 81, 50)] }],
    ["湿度が負", { readings: [reading(undefined, 20, -1)] }],
    ["湿度が 100 超", { readings: [reading(undefined, 20, 101)] }],
    ["気温が文字列", { readings: [{ ...reading(), temperature_c: "20" }] }],
    ["気温が欠けている", { readings: [{ time: "2026-03-01T00:00:00Z", humidity_pct: 50 }] }],
  ])("不正な本文（%s）は 400 で、何も保存しない", async (_, body) => {
    const { post, store } = setup();
    const res = await post(JSON.stringify(body));
    expect(res.status).toBe(400);
    expect(await store.getReadings("2026-02-28", "2026-03-02")).toEqual([]);
  });

  it("JSON が壊れていれば 400", async () => {
    const { post } = setup();
    expect((await post("{")).status).toBe(400);
  });

  it("上限ちょうどの件数は受け付け、超えると 400", async () => {
    const { post } = setup();
    const make = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        reading(new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString()),
      );
    const ok = await post(JSON.stringify({ readings: make(MAX_ROOM_READINGS) }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ written: MAX_ROOM_READINGS, unchanged: 0 });
    const tooMany = await post(JSON.stringify({ readings: make(MAX_ROOM_READINGS + 1) }));
    expect(tooMany.status).toBe(400);
  });

  it("512KB 超の本文は 413", async () => {
    const { post } = setup();
    const res = await post(JSON.stringify({ readings: [reading()], pad: "x".repeat(512 * 1024) }));
    expect(res.status).toBe(413);
  });

  it("保存すると {written, unchanged} を返し、送り直しは unchanged になる", async () => {
    const { post, store } = setup();
    const body = JSON.stringify({
      readings: [reading("2026-03-01T00:00:00Z", 19.5, 40), reading("2026-03-01T00:30:00Z")],
    });
    const first = await post(body);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ written: 2, unchanged: 0 });
    const second = await post(body);
    expect(await second.json()).toEqual({ written: 0, unchanged: 2 });
    expect(await store.getReadings("2026-03-01", "2026-03-01")).toHaveLength(2);
  });

  it("エラー応答にトークンを含めない", async () => {
    const { post } = setup();
    const res = await post("{");
    expect(await res.text()).not.toContain(ROOM_TOKEN);
  });
});
