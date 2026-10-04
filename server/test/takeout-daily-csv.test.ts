import { describe, expect, it } from "vitest";
import { DailySummarySchema } from "../src/domain/daily.js";
import { parseCsv } from "../src/takeout/csv.js";
import { parseDailyCsv } from "../src/takeout/daily-csv.js";

const HEADER =
  "日付,通常の運動（分）のカウント,カロリー（kcal）,距離（m）,ハートポイント（強めの運動）,強めの運動（分）,平均心拍数（拍 / 分）,最大心拍数（拍 / 分）,最小心拍数（拍 / 分）,歩数,平均体重（kg）,「ウォーキング」の時間（ミリ秒）";

describe("parseCsv", () => {
  it('引用符内のカンマ・改行・"" を扱い、BOM と CRLF を無視する', () => {
    const rows = parseCsv('﻿a,b\r\n"x,1","y\n""z"""\r\n');
    expect(rows).toEqual([
      ["a", "b"],
      ["x,1", 'y\n"z"'],
    ]);
  });
});

describe("parseDailyCsv", () => {
  it("ヘッダー名で列を引き、丸めと単位変換を行う（BOM 付き）", () => {
    const csv = `﻿${HEADER}\n2026-01-02,30,1850.2468,5234.56,12,8,71.46,150,52,8123,60.456,1800000\n`;
    const [day] = parseDailyCsv(csv);
    expect(day).toEqual({
      date: "2026-01-02",
      source: "takeout",
      activity: {
        steps: 8123,
        distance_m: 5234.6,
        calories_kcal: 1850.2,
        move_minutes: 30,
        heart_points: 12,
        vigorous_minutes: 8,
        walking_minutes: 30,
      },
      heart_rate: { avg_bpm: 71.5, max_bpm: 150, min_bpm: 52 },
      body: { weight_kg: 60.46 },
    });
    expect(DailySummarySchema.safeParse(day).success).toBe(true);
  });

  it("空セルはフィールドごと省略し、空のセクションも省略する", () => {
    const csv = `${HEADER}\n2026-01-03,,,,,,,,,500,,\n2026-01-04,,,,,,,,,,,\n`;
    const days = parseDailyCsv(csv);
    expect(days[0]).toEqual({
      date: "2026-01-03",
      source: "takeout",
      activity: { steps: 500 },
    });
    expect(days[1]).toEqual({ date: "2026-01-04", source: "takeout" });
    expect(JSON.stringify(days)).not.toContain("null");
  });

  it("列順が違っても動き、存在しない列は無視する", () => {
    const csv = "歩数,日付,未知の列\n100,2026-02-01,x\n";
    expect(parseDailyCsv(csv)).toEqual([
      { date: "2026-02-01", source: "takeout", activity: { steps: 100 } },
    ]);
  });

  it("歩行時間 ms を分に変換（小数1桁）", () => {
    const csv = `${HEADER}\n2026-01-05,,,,,,,,,,,100000\n`;
    expect(parseDailyCsv(csv)[0]?.activity?.walking_minutes).toBe(1.7);
  });

  it("日付が不正な行は捨て、日付列が無ければエラー", () => {
    expect(parseDailyCsv(`${HEADER}\nfoo,,,,,,,,,1,,\n`)).toEqual([]);
    expect(() => parseDailyCsv("歩数\n1\n")).toThrow();
  });
});
