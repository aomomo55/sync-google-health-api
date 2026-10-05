import { describe, expect, it } from "vitest";
import { DailySummarySchema } from "../src/domain/daily.js";
import { buildDays } from "../src/takeout/index.js";
import {
  buildSleepByDate,
  parseSleepJson,
  type Segment,
  sessionize,
  sourceFromFilename,
} from "../src/takeout/sleep.js";

const MIN = 60_000;
// 2026-03-10T00:00:00+09:00
const T0 = Date.parse("2026-03-10T00:00:00+09:00");
const seg = (source: string, startMin: number, endMin: number, stage: number): Segment => ({
  source,
  start: T0 + startMin * MIN,
  end: T0 + endMin * MIN,
  stage,
});
const A = "app.a";
const B = "app.b";
const C = "app.c";

describe("parseSleepJson / sourceFromFilename", () => {
  it("Data Points を Segment にする", () => {
    const json = {
      "Data Points": [
        {
          fitValue: [{ value: { intVal: 5 } }],
          startTimeNanos: String(T0 * 1e6),
          endTimeNanos: String((T0 + 10 * MIN) * 1e6),
        },
        { fitValue: [{ value: { intVal: 4 } }], startTimeNanos: "5", endTimeNanos: "5" },
      ],
    };
    expect(parseSleepJson(json, "s")).toEqual([
      { source: "s", start: T0, end: T0 + 10 * MIN, stage: 5 },
    ]);
    expect(parseSleepJson({}, "s")).toEqual([]);
  });

  it("時刻が 2000〜2100 年の範囲外の記録は捨てて数え、buildSleepByDate が例外を出さない", () => {
    const p = (startNanos: string, endNanos: string) => ({
      fitValue: [{ value: { intVal: 4 } }],
      startTimeNanos: startNanos,
      endTimeNanos: endNanos,
    });
    const ok = p(String(T0 * 1e6), String((T0 + 10 * MIN) * 1e6));
    const json = {
      "Data Points": [
        ok,
        // 有限だが Date で表せないほど大きい（toISOString が RangeError になる）
        p(String(T0 * 1e6), "1e30"),
        p("-1e30", String(T0 * 1e6)),
        // 1999 年
        p(String(Date.UTC(1999, 11, 31) * 1e6), String(Date.UTC(1999, 11, 31, 1) * 1e6)),
        // 2100 年ちょうどは範囲外
        p(String(Date.UTC(2099, 11, 31, 23) * 1e6), String(Date.UTC(2100, 0, 1) * 1e6)),
        p("x", "y"),
      ],
    };
    const stats = { invalidTime: 0 };
    const segs = parseSleepJson(json, "s", stats);
    expect(segs).toEqual([{ source: "s", start: T0, end: T0 + 10 * MIN, stage: 4 }]);
    expect(stats.invalidTime).toBe(5);
    expect(() => buildSleepByDate(segs)).not.toThrow();
    // 範囲の内側ぎりぎりは受け付ける
    const edge = parseSleepJson(
      {
        "Data Points": [
          p(String(Date.UTC(2000, 0, 1) * 1e6), String(Date.UTC(2000, 0, 1, 1) * 1e6)),
        ],
      },
      "s",
    );
    expect(edge).toHaveLength(1);
  });

  it("ファイル名からソースを取り出す（空白入り可、derived は対象外）", () => {
    expect(
      sourceFromFilename("raw_com.google.sleep.segment_app.x_Sleep - activity segments.json"),
    ).toBe("app.x_Sleep - activity segments");
    expect(sourceFromFilename("derived_com.google.sleep.segment_x.json")).toBeUndefined();
  });
});

describe("sessionize", () => {
  it("gap 60 分ちょうどは同一セッション、61 分は別セッション", () => {
    const same = sessionize([seg("a", 0, 10, 4), seg("a", 70, 80, 4)]);
    expect(same).toHaveLength(1);
    const split = sessionize([seg("a", 0, 10, 4), seg("a", 71, 80, 4)]);
    expect(split).toHaveLength(2);
  });

  it("入力順に依存せず、重なる segment の end は最大値を使う", () => {
    const s = sessionize([seg("a", 200, 210, 4), seg("a", 0, 50, 4), seg("a", 10, 20, 4)]);
    expect(s.map((x) => [x.start - T0, x.end - T0])).toEqual([
      [0, 50 * MIN],
      [200 * MIN, 210 * MIN],
    ]);
  });
});

describe("buildSleepByDate", () => {
  it("日跨ぎの睡眠は起床日(JST)に割り当て、ステージを集計する", () => {
    // 3/9 23:00 - 3/10 07:00 (480分): awake 10, out-of-bed 20, deep 60, light 300, rem 90
    const m = (x: number) => x - 60; // 3/9 23:00 を 0 とした分
    const segs = [
      seg(A, m(0), m(10), 1),
      seg(A, m(10), m(70), 5),
      seg(A, m(70), m(370), 4),
      seg(A, m(370), m(390), 3),
      seg(A, m(390), m(480), 6),
    ];
    const r = buildSleepByDate(segs);
    expect([...r.keys()]).toEqual(["2026-03-10"]);
    const c = r.get("2026-03-10")!;
    expect(c.hasStages).toBe(true);
    expect(c.sleep).toEqual({
      start: "2026-03-09T23:00:00+09:00",
      end: "2026-03-10T07:00:00+09:00",
      in_bed_minutes: 480,
      awake_minutes: 30,
      asleep_minutes: 450,
      deep_minutes: 60,
      light_minutes: 300,
      rem_minutes: 90,
    });
    expect(DailySummarySchema.safeParse({ date: "2026-03-10", sleep: c.sleep }).success).toBe(true);
  });

  it("ステージ 4/5/6 が無ければ deep/light/rem を省略する（0 にしない）", () => {
    const r = buildSleepByDate([seg(C, 0, 60, 2), seg(C, 60, 90, 0), seg(C, 90, 100, 1)]);
    const c = r.get("2026-03-10")!;
    expect(c.hasStages).toBe(false);
    expect(c.sleep.asleep_minutes).toBe(90);
    expect(c.sleep.awake_minutes).toBe(10);
    expect(c.sleep).not.toHaveProperty("deep_minutes");
    expect(c.sleep).not.toHaveProperty("light_minutes");
    expect(c.sleep).not.toHaveProperty("rem_minutes");
  });

  it("最長セッションを main とし、他は昼寝として asleep 分を合計する", () => {
    const r = buildSleepByDate([
      seg(A, 60, 420, 4), // 6h main
      seg(A, 600, 630, 4), // nap 30 分
      seg(A, 800, 860, 4), // nap: 60 分のうち awake 10
      seg(A, 850, 860, 1),
    ]);
    const c = r.get("2026-03-10")!;
    expect(c.sleep.in_bed_minutes).toBe(360);
    // 850-860 の awake は 860 までに収まる: 60 - 10 = 50
    expect(c.sleep.nap_minutes).toBe(80);
  });

  it("昼寝が無ければ nap_minutes を付けない", () => {
    const c = buildSleepByDate([seg(A, 60, 420, 4)]).get("2026-03-10")!;
    expect(c.sleep).not.toHaveProperty("nap_minutes");
  });

  it("同じ起床日はステージ付きのソースを、ステージ無しの長いソースより優先する", () => {
    const r = buildSleepByDate([
      seg(A, 0, 500, 2), // ステージ無し（長い）
      seg(B, 30, 420, 4),
      seg(B, 600, 640, 4), // B の昼寝（A とは混ぜない）
    ]);
    const c = r.get("2026-03-10")!;
    expect(c.source).toBe(B);
    expect(c.sleep.in_bed_minutes).toBe(390);
    expect(c.sleep.nap_minutes).toBe(40);
  });

  it("ステージ付きのソースが複数なら合計時間が長い方を使う", () => {
    const r = buildSleepByDate([seg(A, 0, 300, 4), seg(B, 0, 400, 5), seg(C, 0, 500, 2)]);
    expect(r.get("2026-03-10")?.source).toBe(B);
  });

  it("ステージ有無・合計時間が同じなら source id の辞書順で最小を使う（入力順に依存しない）", () => {
    const x = [seg(B, 0, 400, 4), seg(A, 0, 400, 4)];
    expect(buildSleepByDate(x).get("2026-03-10")?.source).toBe(A);
    expect(buildSleepByDate([...x].reverse()).get("2026-03-10")?.source).toBe(A);
  });

  it("別の起床日なら別ソースでもそれぞれ採用する", () => {
    const r = buildSleepByDate([seg(A, 60, 420, 4), seg(C, 24 * 60 + 60, 24 * 60 + 400, 4)]);
    expect(r.get("2026-03-10")?.source).toBe(A);
    expect(r.get("2026-03-11")?.source).toBe(C);
  });
});

describe("buildDays", () => {
  it("睡眠を同じ日に結合し、CSV に無い日は作り、範囲で絞る", () => {
    const csv = [
      { date: "2026-03-10", source: "takeout", activity: { steps: 1 } },
      { date: "2026-03-20", source: "takeout", activity: { steps: 2 } },
    ];
    const { days } = buildDays(csv, [seg(A, 60, 420, 4), seg(A, 24 * 60 + 60, 24 * 60 + 420, 4)]);
    expect(days.map((d) => d.date)).toEqual(["2026-03-10", "2026-03-11", "2026-03-20"]);
    expect(days[0]?.activity).toEqual({ steps: 1 });
    expect(days[0]?.sleep?.in_bed_minutes).toBe(360);
    expect(days[1]).toMatchObject({ source: "takeout" });
    expect(buildDays(csv, [], { from: "2026-03-15" }).days.map((d) => d.date)).toEqual([
      "2026-03-20",
    ]);
  });
});
