import { describe, expect, it } from "vitest";
import { addDays, inclusiveDays, monthKeyRange } from "../src/domain/dates.js";

describe("日付の計算", () => {
  it("inclusiveDays は両端を含む日数を返す", () => {
    expect(inclusiveDays("2026-03-01", "2026-03-01")).toBe(1);
    expect(inclusiveDays("2026-01-01", "2026-12-31")).toBe(365);
    expect(inclusiveDays("2026-03-02", "2026-03-01")).toBe(0);
  });

  it("addDays は月や年をまたいで足し引きする", () => {
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("monthKeyRange は月の全日を文字列の比較で含む範囲を返す", () => {
    const { start, end } = monthKeyRange("2026-02");
    expect(start).toBe("2026-02-01");
    expect(end).toBe("2026-02-31");
    for (const d of ["2026-02-01", "2026-02-28"]) expect(d >= start && d <= end).toBe(true);
    for (const d of ["2026-01-31", "2026-03-01"]) expect(d >= start && d <= end).toBe(false);
  });
});
