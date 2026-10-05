import { describe, expect, it } from "vitest";
import { DailySummarySchema, LIMITS } from "../src/domain/daily.js";

const ok = (day: unknown) => DailySummarySchema.safeParse(day).success;

describe("DailySummarySchema の上限と前後関係", () => {
  it("上限ちょうどの値は受け付ける", () => {
    expect(
      ok({
        date: "2026-01-01",
        activity: {
          steps: LIMITS.steps,
          distance_m: LIMITS.distanceM,
          calories_kcal: LIMITS.kcal,
          move_minutes: LIMITS.dayMinutes,
          heart_points: LIMITS.heartPoints,
          vigorous_minutes: LIMITS.dayMinutes,
          walking_minutes: LIMITS.dayMinutes,
        },
        heart_rate: { avg_bpm: 300, max_bpm: 300, min_bpm: 300, resting_bpm: 300 },
        body: { weight_kg: 500, body_fat_pct: 100 },
        nutrition: { energy_kcal: 50000, protein_g: 5000, fat_g: 5000, carbs_g: 5000 },
        sleep: { asleep_minutes: LIMITS.sleepMinutes, nap_minutes: LIMITS.sleepMinutes },
      }),
    ).toBe(true);
  });

  it("Android や Takeout が送る小数（距離・kcal・平均心拍・体重・分）は受け付ける", () => {
    expect(
      ok({
        date: "2026-01-01",
        activity: { distance_m: 1234.5, calories_kcal: 1500.3, walking_minutes: 12.5 },
        heart_rate: { avg_bpm: 65.4 },
        body: { weight_kg: 55.25, body_fat_pct: 20.1 },
        nutrition: { energy_kcal: 1800, protein_g: 60.2 },
      }),
    ).toBe(true);
  });

  it.each([
    ["steps", { activity: { steps: LIMITS.steps + 1 } }],
    ["steps の小数", { activity: { steps: 100.5 } }],
    ["distance_m", { activity: { distance_m: LIMITS.distanceM + 1 } }],
    ["move_minutes", { activity: { move_minutes: 1441 } }],
    ["avg_bpm", { heart_rate: { avg_bpm: 301 } }],
    ["weight_kg", { body: { weight_kg: 500.1 } }],
    ["body_fat_pct", { body: { body_fat_pct: 100.1 } }],
    ["energy_kcal", { nutrition: { energy_kcal: 1e308 } }],
    ["protein_g", { nutrition: { protein_g: 5001 } }],
    ["asleep_minutes", { sleep: { asleep_minutes: 2881 } }],
  ])("上限を超える %s は拒否する", (_name, section) => {
    expect(ok({ date: "2026-01-01", ...section })).toBe(false);
  });

  it("睡眠の end が start より前なら拒否し、同時刻や片方だけは受け付ける", () => {
    const sleep = (start: string | null | undefined, end: string | null | undefined) =>
      ok({ date: "2026-01-02", sleep: { start, end } });
    expect(sleep("2026-01-02T07:00:00+09:00", "2026-01-01T23:00:00+09:00")).toBe(false);
    // オフセットが違っても時刻として比べる
    expect(sleep("2026-01-01T23:00:00+09:00", "2026-01-01T15:30:00Z")).toBe(true);
    expect(sleep("2026-01-01T23:00:00+09:00", "2026-01-01T23:00:00+09:00")).toBe(true);
    expect(sleep(undefined, "2026-01-02T07:00:00+09:00")).toBe(true);
    expect(sleep(null, "2026-01-02T07:00:00+09:00")).toBe(true);
  });

  it("null（値の削除）と省略は引き続き受け付ける", () => {
    expect(ok({ date: "2026-01-01", activity: { steps: null }, sleep: { start: null } })).toBe(
      true,
    );
  });
});
