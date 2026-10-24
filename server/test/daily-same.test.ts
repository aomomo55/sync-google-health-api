import { describe, expect, it } from "vitest";
import { isSameDay } from "../src/domain/daily.js";

describe("isSameDay", () => {
  it("キーの順序が違っても同じとみなす", () => {
    expect(
      isSameDay(
        { date: "2026-01-01", activity: { steps: 1, distance_m: 2 } },
        { activity: { distance_m: 2, steps: 1 }, date: "2026-01-01" },
      ),
    ).toBe(true);
  });

  it("値が undefined の項目は無いものとみなし、null とは区別する", () => {
    const base = { date: "2026-01-01", activity: { steps: 1 } };
    expect(isSameDay(base, { ...base, body: undefined })).toBe(true);
    expect(isSameDay(base, { ...base, activity: { steps: 1, distance_m: null } })).toBe(false);
  });

  it("値が違えば別とみなす", () => {
    const day = (steps: number) => ({ date: "2026-01-01", activity: { steps } });
    expect(isSameDay(day(1), day(2))).toBe(false);
  });
});
