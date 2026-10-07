import { describe, expect, it } from "vitest";
import {
  addDays,
  formatHm,
  inclusiveDays,
  jstMinutesOfDay,
  monthKeyRange,
} from "../src/domain/dates.js";

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

  it("jstMinutesOfDay はオフセットに関係なく JST の 0:00 からの分を返し、秒は切り捨てる", () => {
    expect(jstMinutesOfDay("2026-03-10T07:05:59+09:00")).toBe(7 * 60 + 5);
    expect(jstMinutesOfDay("2026-03-09T15:30:00Z")).toBe(30);
    expect(jstMinutesOfDay("2026-03-09T23:30:00-08:00")).toBe(16 * 60 + 30);
    expect(jstMinutesOfDay(null)).toBeNull();
    expect(jstMinutesOfDay("not a date")).toBeNull();
  });

  it("formatHm は分を四捨五入し、24 時間で巻き戻して HH:MM にする", () => {
    expect(formatHm(0)).toBe("00:00");
    expect(formatHm(7 * 60 + 5)).toBe("07:05");
    expect(formatHm(1439.6)).toBe("00:00");
    expect(formatHm(1440 + 30)).toBe("00:30");
    expect(formatHm(-30)).toBe("23:30");
  });
});
