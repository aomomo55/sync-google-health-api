import { describe, expect, it } from "vitest";
import type { DailySummary } from "../src/domain/daily.js";
import { summarizeMonth, summarizeMonths } from "../src/domain/monthly.js";

const sleepDay = (date: string, start: string): DailySummary => ({
  date,
  sleep: { start, asleep_minutes: 400 },
});

describe("summarizeMonth", () => {
  it("23:30 と 00:30 の平均就寝時刻は 00:00", () => {
    const m = summarizeMonth("2026-01", [
      sleepDay("2026-01-01", "2025-12-31T23:30:00+09:00"),
      sleepDay("2026-01-02", "2026-01-02T00:30:00+09:00"),
    ]);
    expect(m.sleep.avg_bedtime).toBe("00:00");
  });

  it("22:00 と 23:00 は 22:30", () => {
    const m = summarizeMonth("2026-01", [
      sleepDay("2026-01-01", "2026-01-01T22:00:00+09:00"),
      sleepDay("2026-01-02", "2026-01-02T23:00:00+09:00"),
    ]);
    expect(m.sleep.avg_bedtime).toBe("22:30");
  });

  it("データが無ければ null と 0", () => {
    const m = summarizeMonth("2026-01", []);
    expect(m.days_with_data).toBe(0);
    expect(m.activity.avg_steps).toBeNull();
    expect(m.sleep.nights).toBe(0);
  });

  it("丸め: 歩数は整数、体重は小数1桁、距離は km 小数2桁", () => {
    const m = summarizeMonth("2026-01", [
      { date: "2026-01-01", activity: { steps: 1, distance_m: 1234 }, body: { weight_kg: 60.04 } },
      { date: "2026-01-02", activity: { steps: 2 }, body: { weight_kg: 60.1 } },
    ]);
    expect(m.activity.avg_steps).toBe(2);
    expect(m.activity.total_distance_km).toBe(1.23);
    expect(m.body.avg_weight_kg).toBe(60.1);
  });
});

describe("summarizeMonths", () => {
  it("月ごとに昇順でグルーピングし、全て null の日だけの月は除く", () => {
    const r = summarizeMonths([
      { date: "2026-02-01", activity: { steps: 10 } },
      { date: "2026-01-01", activity: { steps: 20 } },
      { date: "2026-03-01", activity: { steps: null } },
    ]);
    expect(r.map((m) => m.month)).toEqual(["2026-01", "2026-02"]);
  });
});
