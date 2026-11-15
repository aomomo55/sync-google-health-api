import { describe, expect, it } from "vitest";
import {
  fromJstSlot,
  groupByJstDate,
  MIN_READINGS_PER_HOUR,
  mergeSlots,
  type RoomReading,
  type RoomSlot,
  summarizeNights,
  toJstSlot,
} from "../src/domain/room.js";

const reading = (time: string, t = 20, h = 50): RoomReading => ({
  time,
  temperature_c: t,
  humidity_pct: h,
});

const slot = (time: string, t = 20, h = 50): RoomSlot => ({
  time,
  temperature_c: t,
  humidity_pct: h,
});

describe("toJstSlot", () => {
  it("UTC を Asia/Tokyo の日付と時刻に直す", () => {
    expect(toJstSlot(reading("2026-03-01T00:30:00Z", 19.5, 40))).toEqual({
      date: "2026-03-01",
      slot: { time: "09:30", temperature_c: 19.5, humidity_pct: 40 },
    });
  });

  it("別のオフセットも Asia/Tokyo に直す", () => {
    expect(toJstSlot(reading("2026-03-01T00:30:00-05:00")).slot.time).toBe("14:30");
    expect(toJstSlot(reading("2026-03-01T10:15:00+09:00")).slot.time).toBe("10:15");
  });

  it("秒は切り捨てる", () => {
    expect(toJstSlot(reading("2026-03-01T00:30:59Z")).slot.time).toBe("09:30");
  });

  it("15:00Z で日付が繰り上がる", () => {
    expect(toJstSlot(reading("2026-03-01T14:59:00Z"))).toMatchObject({
      date: "2026-03-01",
      slot: { time: "23:59" },
    });
    expect(toJstSlot(reading("2026-03-01T15:00:00Z"))).toMatchObject({
      date: "2026-03-02",
      slot: { time: "00:00" },
    });
  });
});

describe("fromJstSlot", () => {
  it("Asia/Tokyo のオフセット付きの読み取り値に戻す", () => {
    expect(fromJstSlot("2026-03-02", slot("00:05", 18, 55))).toEqual({
      time: "2026-03-02T00:05:00+09:00",
      temperature_c: 18,
      humidity_pct: 55,
    });
  });
});

describe("groupByJstDate", () => {
  it("同じ分の値は後のものを使う", () => {
    const grouped = groupByJstDate([
      reading("2026-03-01T00:30:10Z", 20, 50),
      reading("2026-03-01T00:30:50Z", 21, 51),
    ]);
    expect(grouped.get("2026-03-01")).toEqual([slot("09:30", 21, 51)]);
  });

  it("日付も時刻も昇順に並べる", () => {
    const grouped = groupByJstDate([
      reading("2026-03-02T00:00:00Z"),
      reading("2026-03-01T03:00:00Z"),
      reading("2026-03-01T01:00:00Z"),
      reading("2026-03-01T15:00:00Z"),
    ]);
    expect([...grouped.keys()]).toEqual(["2026-03-01", "2026-03-02"]);
    expect(grouped.get("2026-03-01")?.map((s) => s.time)).toEqual(["10:00", "12:00"]);
    expect(grouped.get("2026-03-02")?.map((s) => s.time)).toEqual(["00:00", "09:00"]);
  });

  it("空なら空の Map", () => {
    expect(groupByJstDate([]).size).toBe(0);
  });
});

describe("mergeSlots", () => {
  it("新しい値だけを数える", () => {
    const r = mergeSlots([slot("09:00")], [slot("09:30"), slot("10:00")]);
    expect(r.changed).toBe(2);
    expect(r.slots.map((s) => s.time)).toEqual(["09:00", "09:30", "10:00"]);
  });

  it("値が変わったものだけを数え、同じ値は数えない", () => {
    const r = mergeSlots(
      [slot("09:00", 20, 50), slot("09:30", 20, 50)],
      [slot("09:00", 20, 50), slot("09:30", 21, 50)],
    );
    expect(r.changed).toBe(1);
    expect(r.slots).toEqual([slot("09:00", 20, 50), slot("09:30", 21, 50)]);
  });

  it("湿度だけが変わっても変わった扱い", () => {
    expect(mergeSlots([slot("09:00", 20, 50)], [slot("09:00", 20, 51)]).changed).toBe(1);
  });

  it("全て同じなら 0 件", () => {
    expect(mergeSlots([slot("09:00")], [slot("09:00")]).changed).toBe(0);
  });
});

describe("summarizeNights", () => {
  const night = (start?: string | null, end?: string | null) => [
    { date: "2026-03-02", start, end },
  ];
  // 2 時間の夜: 01:00〜03:00（+09:00）
  const START = "2026-03-02T01:00:00+09:00";
  const END = "2026-03-02T03:00:00+09:00";

  it("就寝・起床の時刻を含む範囲で集計する", () => {
    const readings = [
      reading("2026-03-02T01:00:00+09:00", 20, 50),
      reading("2026-03-02T02:00:00+09:00", 22, 60),
      reading("2026-03-02T03:00:00+09:00", 21, 55),
    ];
    expect(summarizeNights(night(START, END), readings).get("2026-03-02")).toEqual({
      avg_temperature_c: 21,
      min_temperature_c: 20,
      max_temperature_c: 22,
      avg_humidity_pct: 55,
      readings: 3,
    });
  });

  it("範囲の外の値は含めない", () => {
    const readings = [
      reading("2026-03-02T00:59:00+09:00", 99, 99),
      reading("2026-03-02T01:30:00+09:00", 20, 50),
      reading("2026-03-02T02:30:00+09:00", 22, 60),
      reading("2026-03-02T03:01:00+09:00", -10, 1),
    ];
    const c = summarizeNights(night(START, END), readings).get("2026-03-02");
    expect(c).toMatchObject({ min_temperature_c: 20, max_temperature_c: 22, readings: 2 });
  });

  it("オフセットが違う時刻も同じ瞬間として扱う", () => {
    const readings = [
      reading("2026-03-01T16:00:00Z", 20, 50),
      reading("2026-03-01T17:00:00Z", 22, 50),
    ];
    expect(summarizeNights(night(START, END), readings).get("2026-03-02")?.readings).toBe(2);
  });

  it("件数が 1 時間あたりの基準に足りないと含めない", () => {
    const required = 2 * MIN_READINGS_PER_HOUR;
    const make = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        reading(`2026-03-02T01:${String(i).padStart(2, "0")}:00+09:00`),
      );
    expect(summarizeNights(night(START, END), make(required - 1)).size).toBe(0);
    expect(summarizeNights(night(START, END), make(required)).size).toBe(1);
  });

  it("1 時間に満たない夜でも、最低 1 件は必要", () => {
    const start = "2026-03-02T01:00:00+09:00";
    const end = "2026-03-02T01:30:00+09:00";
    expect(summarizeNights(night(start, end), []).size).toBe(0);
    expect(summarizeNights(night(start, end), [reading("2026-03-02T01:10:00+09:00")]).size).toBe(1);
  });

  it.each([
    ["就寝が無い", undefined, END],
    ["起床が無い", START, undefined],
    ["null", null, null],
    ["就寝が不正", "not-a-date", END],
    ["起床が不正", START, "not-a-date"],
    ["起床が就寝と同じ", START, START],
    ["起床が就寝より前", END, START],
  ])("%s なら結果に含めない", (_, start, end) => {
    const readings = [reading("2026-03-02T02:00:00+09:00"), reading("2026-03-02T01:30:00+09:00")];
    expect(summarizeNights(night(start, end), readings).size).toBe(0);
  });

  it("気温は小数 1 桁、湿度は整数に丸める", () => {
    const readings = [
      reading("2026-03-02T01:00:00+09:00", 20.1, 50),
      reading("2026-03-02T02:00:00+09:00", 20.2, 51),
      reading("2026-03-02T02:30:00+09:00", 20.2, 51),
    ];
    const c = summarizeNights(night(START, END), readings).get("2026-03-02");
    expect(c?.avg_temperature_c).toBe(20.2);
    expect(c?.avg_humidity_pct).toBe(51);
  });

  it("複数の夜をそれぞれ集計する", () => {
    const nights = [
      { date: "2026-03-02", start: START, end: END },
      { date: "2026-03-03", start: "2026-03-03T01:00:00+09:00", end: "2026-03-03T03:00:00+09:00" },
    ];
    const readings = [
      reading("2026-03-02T01:30:00+09:00", 18),
      reading("2026-03-02T02:30:00+09:00", 18),
      reading("2026-03-03T01:30:00+09:00", 24),
      reading("2026-03-03T02:30:00+09:00", 24),
    ];
    const r = summarizeNights(nights, readings);
    expect(r.get("2026-03-02")?.avg_temperature_c).toBe(18);
    expect(r.get("2026-03-03")?.avg_temperature_c).toBe(24);
  });

  it("読み取り値が時刻の順に並んでいなくても、同じ結果になる", () => {
    const nights = [
      { date: "2026-03-02", start: START, end: END },
      { date: "2026-03-03", start: "2026-03-03T01:00:00+09:00", end: "2026-03-03T03:00:00+09:00" },
    ];
    const readings = [
      reading("2026-03-02T01:30:00+09:00", 18, 50),
      reading("2026-03-02T02:30:00+09:00", 19, 52),
      reading("2026-03-03T01:30:00+09:00", 24, 60),
      reading("2026-03-03T02:30:00+09:00", 25, 62),
    ];
    const shuffled = [readings[2]!, readings[0]!, readings[3]!, readings[1]!];
    expect(summarizeNights(nights, shuffled)).toEqual(summarizeNights(nights, readings));
  });
});
