import { describe, expect, it } from "vitest";
import type { DailySummary } from "../src/domain/daily.js";
import { affectedNotes, planNotes, splitValidDays } from "../src/sync/plan.js";

const day = (date: string, steps = 1000): DailySummary => ({
  date,
  activity: { steps },
});
const DAYS = [
  day("2026-01-30"),
  day("2026-02-01"),
  day("2026-02-05"),
  day("2026-02-10"),
  day("2026-03-01"),
];

describe("affectedNotes", () => {
  it("対象日と前後の既存日を含み、データの無い日は無視する", () => {
    const r = affectedNotes(DAYS, ["2026-02-05", "2026-02-07"]);
    expect(r.dates).toEqual(["2026-02-01", "2026-02-05", "2026-02-10"]);
    expect(r.months).toEqual(["2026-02"]);
  });

  it("端の日は片側のみ、月をまたぐ隣は月も含む", () => {
    const r = affectedNotes(DAYS, ["2026-02-01"]);
    expect(r.dates).toEqual(["2026-01-30", "2026-02-01", "2026-02-05"]);
    expect(r.months).toEqual(["2026-01", "2026-02"]);
    expect(affectedNotes(DAYS, ["2026-01-30"]).dates).toEqual(["2026-01-30", "2026-02-01"]);
  });
});

describe("planNotes", () => {
  it("日次・月次のパスと前後リンクを生成する", () => {
    const items = planNotes(DAYS, ["2026-02-05"]);
    expect(items.map((i) => i.path)).toEqual([
      "Health/Daily/2026-02-01.md",
      "Health/Daily/2026-02-05.md",
      "Health/Daily/2026-02-10.md",
      "Health/Monthly/2026-02.md",
    ]);
    const mid = items[1]!.render(null);
    expect(mid).toContain("Daily/2026-02-01|前日");
    expect(mid).toContain("Daily/2026-02-10|翌日");
  });

  it("不正な日付の日はノートにもリンクにも入れず、正しい日の出力は変えない", () => {
    const withBad = [...DAYS.slice(0, 3), day("2026-02-0x: injected"), ...DAYS.slice(3)];
    const items = planNotes(withBad, ["2026-02-05", "2026-02-0x: injected"]);
    const expected = planNotes(DAYS, ["2026-02-05"]);
    expect(items.map((i) => [i.path, i.render(null)])).toEqual(
      expected.map((i) => [i.path, i.render(null)]),
    );
    expect(splitValidDays(withBad).invalid.map((d) => d.date)).toEqual(["2026-02-0x: injected"]);
  });

  it("月次は月内の全日で集計する", () => {
    const monthly = planNotes([day("2026-02-01", 1000), day("2026-02-20", 3000)], ["2026-02-20"])
      .find((i) => i.path.endsWith("Monthly/2026-02.md"))!
      .render(null);
    expect(monthly).toContain("2000");
  });

  it("既存メモを保持する", () => {
    const item = planNotes(DAYS, ["2026-02-05"])[1]!;
    const edited = `${item.render(null)}\n自分のメモ\n`;
    expect(item.render(edited)).toBe(edited);
  });

  it("includeStatic で静的ノートが加わる", () => {
    const without = planNotes(DAYS, ["2026-02-05"]);
    const withStatic = planNotes(DAYS, ["2026-02-05"], undefined, { includeStatic: true });
    expect(withStatic.length - without.length).toBe(5);
    expect(withStatic.some((i) => i.path.endsWith(".base"))).toBe(true);
  });

  it("root を反映し、結果は決定的", () => {
    const a = planNotes(DAYS, ["2026-02-05"], "Health/_it");
    const b = planNotes(DAYS, ["2026-02-05"], "Health/_it");
    expect(a.every((i) => i.path.startsWith("Health/_it/"))).toBe(true);
    expect(a.map((i) => [i.path, i.render(null)])).toEqual(b.map((i) => [i.path, i.render(null)]));
  });

  it("対象が無ければ空", () => {
    expect(planNotes(DAYS, ["2030-01-01"])).toEqual([]);
  });
});
