import { describe, expect, it } from "vitest";
import { parseRoomCsv } from "../scripts/room-csv.js";

const HEADER = "timestamp,temperature(℃),humidity(%),dpt(℃),vpd(kPa),absoluteHumidity(g/m³)";
const ROW1 = "2025-01-01 00:30:00,19.9,51,9.5,1.14,8.76";
const ROW2 = "2025-01-01 01:00:00,19.5,52,9.4,1.12,8.70";

describe("parseRoomCsv", () => {
  it("正しいファイルを読み、時刻を +09:00 として扱う", () => {
    const r = parseRoomCsv([HEADER, ROW1, ROW2, ""].join("\n"));
    expect(r.invalid).toEqual([]);
    expect(r.readings).toEqual([
      { time: "2025-01-01T00:30:00+09:00", temperature_c: 19.9, humidity_pct: 51 },
      { time: "2025-01-01T01:00:00+09:00", temperature_c: 19.5, humidity_pct: 52 },
    ]);
  });

  it("BOM を読み飛ばす", () => {
    const r = parseRoomCsv(`﻿${[HEADER, ROW1].join("\n")}`);
    expect(r.readings).toHaveLength(1);
  });

  it("CRLF の改行を読める", () => {
    const r = parseRoomCsv([HEADER, ROW1, ROW2].join("\r\n"));
    expect(r.readings).toHaveLength(2);
    expect(r.invalid).toEqual([]);
  });

  it("空行は読み飛ばし、不正な行としても報告しない", () => {
    const r = parseRoomCsv([HEADER, "", ROW1, "  ,  ,", "", ROW2, ""].join("\n"));
    expect(r.readings).toHaveLength(2);
    expect(r.invalid).toEqual([]);
  });

  it("先頭の行が想定と違うと throw する", () => {
    expect(() => parseRoomCsv(`time,temp,hum\n${ROW1}`)).toThrow(/先頭の行/);
    expect(() => parseRoomCsv("")).toThrow(/先頭の行/);
  });

  it("不正な行は 1 始まりの行番号で報告し、結果に含めない", () => {
    const r = parseRoomCsv(
      [
        HEADER, // 1
        ROW1, // 2
        "2025-01-01T01:00:00,20,50", // 3: timestamp の形が違う
        "2025-01-01 02:00:00,,50", // 4: 気温が空
        "2025-01-01 03:00:00,20,", // 5: 湿度が空
        "2025-01-01 04:00:00,200,50", // 6: 気温が範囲外
        "2025-01-01 05:00:00,20,101", // 7: 湿度が範囲外
        "2025-01-01 06:00:00,abc,50", // 8: 数値でない
        "2025-02-30 06:00:00,20,50", // 9: 実在しない日付
        ROW2, // 10
      ].join("\n"),
    );
    expect(r.readings.map((x) => x.time)).toEqual([
      "2025-01-01T00:30:00+09:00",
      "2025-01-01T01:00:00+09:00",
    ]);
    expect(r.invalid.map((x) => x.line)).toEqual([3, 4, 5, 6, 7, 8, 9]);
    expect(r.invalid.every((x) => x.error.length > 0)).toBe(true);
  });
});
