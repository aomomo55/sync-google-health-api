import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { MemoryStore } from "../src/store/memory-store.js";
import { NoteSync } from "../src/sync/note-sync.js";
import { MemoryVaultWriter } from "../src/vault/memory-vault-writer.js";

const TOKEN = "t".repeat(32);
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  app = createApp({ config: { API_TOKEN: TOKEN }, store: new MemoryStore() });
});

function call(path: string, init: RequestInit = {}, auth = true) {
  return app.request(path, {
    ...init,
    headers: {
      ...(auth ? { Authorization: `Bearer ${TOKEN}` } : {}),
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
}

function ingest(body: unknown) {
  return call("/api/ingest", { method: "POST", body: JSON.stringify(body) });
}

describe("認証", () => {
  it.each([
    ["POST", "/api/ingest"],
    ["GET", "/api/summary?date=2026-01-01"],
    ["GET", "/api/summary/monthly?from=2026-01&to=2026-01"],
  ])("%s %s はトークンなしで 401", async (method, path) => {
    const res = await call(path, { method }, false);
    expect(res.status).toBe(401);
  });
});

describe("POST /api/ingest", () => {
  it.each([
    ["実在しない日付", { days: [{ date: "2026-02-30" }] }],
    ["負の数", { days: [{ date: "2026-01-01", activity: { steps: -1 } }] }],
    ["未知のトップレベルキー", { days: [{ date: "2026-01-01", foo: 1 }] }],
    [
      "未知のセクション内キー",
      { days: [{ date: "2026-01-01", activity: { step: 1 } }] },
    ],
    [
      "日付重複",
      { days: [{ date: "2026-01-01" }, { date: "2026-01-01" }] },
    ],
    ["空配列", { days: [] }],
    [
      "401件",
      {
        days: Array.from({ length: 401 }, (_, i) => ({
          date: new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10),
        })),
      },
    ],
    [
      "オフセット無しの datetime",
      { days: [{ date: "2026-01-01", sleep: { start: "2026-01-01T23:00:00" } }] },
    ],
    ["ルートの未知キー", { days: [{ date: "2026-01-01" }], extra: 1 }],
  ])("400: %s", async (_name, body) => {
    const res = await ingest(body);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(typeof json.error).toBe("string");
    expect(json.error).not.toMatch(/\n\s+at /);
  });

  it("JSON が壊れていれば 400", async () => {
    const res = await call("/api/ingest", { method: "POST", body: "{" });
    expect(res.status).toBe(400);
  });

  it("2MB 超は 413", async () => {
    const res = await call("/api/ingest", {
      method: "POST",
      body: JSON.stringify({ pad: "x".repeat(2 * 1024 * 1024 + 1) }),
    });
    expect(res.status).toBe(413);
  });

  it("保存して取得でき、部分更新では既存値が残り null は上書きする", async () => {
    const r1 = await ingest({
      days: [
        {
          date: "2026-01-01",
          activity: { steps: 1000, distance_m: 800 },
          body: { weight_kg: 60 },
          source: "health_connect",
        },
      ],
    });
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ written: 1, notes: null });

    await ingest({
      days: [
        {
          date: "2026-01-01",
          activity: { steps: 2000, distance_m: null, move_minutes: 30 },
          heart_rate: { avg_bpm: 70 },
        },
      ],
    });

    const res = await call("/api/summary?date=2026-01-01");
    expect(await res.json()).toEqual({
      days: [
        {
          date: "2026-01-01",
          activity: { steps: 2000, distance_m: null, move_minutes: 30 },
          body: { weight_kg: 60 },
          heart_rate: { avg_bpm: 70 },
          source: "health_connect",
        },
      ],
    });
  });
});

describe("GET /api/summary", () => {
  beforeEach(async () => {
    await ingest({
      days: [
        {
          date: "2026-01-03",
          activity: { steps: 3 },
          sleep: { asleep_minutes: 400 },
        },
        { date: "2026-01-01", activity: { steps: 1 }, body: { weight_kg: 60 } },
        { date: "2026-01-02", heart_rate: { avg_bpm: 65 } },
      ],
    });
  });

  it("date 指定、無ければ空配列", async () => {
    const res = await call("/api/summary?date=2026-01-01");
    expect(await res.json()).toEqual({
      days: [
        { date: "2026-01-01", activity: { steps: 1 }, body: { weight_kg: 60 } },
      ],
    });
    const none = await call("/api/summary?date=2030-01-01");
    expect(await none.json()).toEqual({ days: [] });
  });

  it("範囲指定は両端含み昇順", async () => {
    const res = await call("/api/summary?from=2026-01-01&to=2026-01-02");
    const json = (await res.json()) as { days: { date: string }[] };
    expect(json.days.map((d) => d.date)).toEqual(["2026-01-01", "2026-01-02"]);
  });

  it("types で絞り込み（date は常に含む）", async () => {
    const res = await call(
      "/api/summary?from=2026-01-01&to=2026-01-03&types=activity,sleep",
    );
    expect(await res.json()).toEqual({
      days: [
        { date: "2026-01-01", activity: { steps: 1 } },
        { date: "2026-01-02" },
        {
          date: "2026-01-03",
          activity: { steps: 3 },
          sleep: { asleep_minutes: 400 },
        },
      ],
    });
  });

  it.each([
    ["不明な types", "/api/summary?date=2026-01-01&types=foo"],
    ["パラメータ無し", "/api/summary"],
    ["from のみ", "/api/summary?from=2026-01-01"],
    ["date と from/to の併用", "/api/summary?date=2026-01-01&from=2026-01-01&to=2026-01-02"],
    ["from > to", "/api/summary?from=2026-01-02&to=2026-01-01"],
    ["401日", "/api/summary?from=2025-01-01&to=2026-02-05"],
    ["不正な日付", "/api/summary?date=2026-13-01"],
  ])("400: %s", async (_n, path) => {
    const res = await call(path);
    expect(res.status).toBe(400);
  });

  it("400日ちょうどは OK", async () => {
    const res = await call("/api/summary?from=2025-01-01&to=2026-02-04");
    expect(res.status).toBe(200);
  });
});

describe("GET /api/summary/monthly", () => {
  it("月次集計（日跨ぎの就寝時刻・null の扱い）", async () => {
    await ingest({
      days: [
        {
          date: "2026-01-10",
          activity: { steps: 1000, distance_m: 700, move_minutes: 10 },
          heart_rate: { avg_bpm: 60 },
          body: { weight_kg: 60 },
          sleep: {
            start: "2026-01-09T23:30:00+09:00",
            end: "2026-01-10T06:30:00+09:00",
            asleep_minutes: 360,
            in_bed_minutes: 420,
            nap_minutes: 20,
            deep_minutes: 60,
          },
        },
        {
          date: "2026-01-11",
          activity: { steps: 2000, distance_m: 1300, move_minutes: null },
          heart_rate: { avg_bpm: null },
          body: { weight_kg: 61 },
          sleep: {
            // UTC 表記でも JST に換算される（00:30 JST）
            start: "2026-01-10T15:30:00Z",
            end: "2026-01-11T07:30:00+09:00",
            asleep_minutes: 480,
            in_bed_minutes: 540,
          },
        },
        { date: "2026-01-12", activity: { steps: null } },
        { date: "2026-02-01", activity: { steps: 500 } },
      ],
    });

    const res = await call("/api/summary/monthly?from=2026-01&to=2026-02");
    expect(res.status).toBe(200);
    const { months } = (await res.json()) as {
      months: { month: string; sleep: Record<string, unknown> }[];
    };
    expect(months.map((m) => m.month)).toEqual(["2026-01", "2026-02"]);
    expect(months[0]).toEqual({
      month: "2026-01",
      days_with_data: 2,
      activity: {
        avg_steps: 1500,
        total_distance_km: 2,
        total_move_minutes: 10,
        total_walking_minutes: null,
      },
      heart_rate: { avg_bpm: 60 },
      body: { avg_weight_kg: 60.5 },
      sleep: {
        nights: 2,
        avg_asleep_hours: 7,
        avg_in_bed_hours: 8,
        avg_bedtime: "00:00",
        avg_wake_time: "07:00",
        total_nap_minutes: 20,
        avg_deep_minutes: 60,
        avg_light_minutes: null,
        avg_rem_minutes: null,
      },
    });
    expect(months[1]?.sleep.nights).toBe(0);
    expect(months[1]?.sleep.avg_bedtime).toBeNull();
  });

  it.each([
    ["形式不正", "/api/summary/monthly?from=2026-1&to=2026-02"],
    ["パラメータ無し", "/api/summary/monthly"],
    ["from > to", "/api/summary/monthly?from=2026-03&to=2026-02"],
    ["121か月", "/api/summary/monthly?from=2016-01&to=2026-01"],
  ])("400: %s", async (_n, path) => {
    expect((await call(path)).status).toBe(400);
  });
});
