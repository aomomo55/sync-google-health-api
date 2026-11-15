import { z } from "zod";
import { round } from "../shared/rounding.js";
import { JST_OFFSET, JST_OFFSET_MS, MS_PER_MINUTE } from "./dates.js";

// 寝室の温湿度計の読み取り値（ADR 0033）。どのメーカーの計測器かは知らない。
// 上限・下限は室内でありえない値（誤送信や単位の取り違え）を止めるためのもの
export const ROOM_LIMITS = {
  minTemperatureC: -40,
  maxTemperatureC: 80,
  maxHumidityPct: 100,
} as const;

export const RoomReadingSchema = z.strictObject({
  time: z.iso.datetime({ offset: true }),
  temperature_c: z
    .number()
    .min(ROOM_LIMITS.minTemperatureC, `${ROOM_LIMITS.minTemperatureC} 以上である必要があります`)
    .max(ROOM_LIMITS.maxTemperatureC, `${ROOM_LIMITS.maxTemperatureC} 以下である必要があります`),
  humidity_pct: z
    .number()
    .min(0, "0 以上である必要があります")
    .max(ROOM_LIMITS.maxHumidityPct, `${ROOM_LIMITS.maxHumidityPct} 以下である必要があります`),
});

export type RoomReading = z.infer<typeof RoomReadingSchema>;

// 保存するときの 1 件。日付ごとの文書に、Asia/Tokyo の時刻（HH:MM）で並べる
export interface RoomSlot {
  time: string;
  temperature_c: number;
  humidity_pct: number;
}

/** 読み取り値を Asia/Tokyo の日付と分単位の時刻に分ける（秒は切り捨て）。time は検証済みであること */
export function toJstSlot(reading: RoomReading): { date: string; slot: RoomSlot } {
  const jst = new Date(
    Math.floor(Date.parse(reading.time) / MS_PER_MINUTE) * MS_PER_MINUTE + JST_OFFSET_MS,
  ).toISOString();
  return {
    date: jst.slice(0, 10),
    slot: {
      time: jst.slice(11, 16),
      temperature_c: reading.temperature_c,
      humidity_pct: reading.humidity_pct,
    },
  };
}

/** 保存した 1 件を、読み取り値の形（Asia/Tokyo のオフセット付き）に戻す */
export function fromJstSlot(date: string, slot: RoomSlot): RoomReading {
  return {
    time: `${date}T${slot.time}:00${JST_OFFSET}`,
    temperature_c: slot.temperature_c,
    humidity_pct: slot.humidity_pct,
  };
}

/**
 * 読み取り値を日付ごとにまとめる。同じ分の値が複数あれば後のものを使う。
 * 日付も時刻も昇順に並べる
 */
export function groupByJstDate(readings: RoomReading[]): Map<string, RoomSlot[]> {
  const byDate = readings.map(toJstSlot).reduce((acc, { date, slot }) => {
    const slots = acc.get(date) ?? new Map<string, RoomSlot>();
    slots.set(slot.time, slot);
    return acc.set(date, slots);
  }, new Map<string, Map<string, RoomSlot>>());
  return new Map(
    [...byDate.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, slots]) => [date, sortSlots([...slots.values()])]),
  );
}

export function sortSlots(slots: RoomSlot[]): RoomSlot[] {
  return [...slots].sort((a, b) => a.time.localeCompare(b.time));
}

/** 既存の値に新しい値を重ねる。変わった（または増えた）件数も返す */
export function mergeSlots(
  existing: RoomSlot[],
  incoming: RoomSlot[],
): { slots: RoomSlot[]; changed: number } {
  const old = new Map(existing.map((s) => [s.time, s]));
  const changed = incoming.filter((s) => {
    const o = old.get(s.time);
    return !o || o.temperature_c !== s.temperature_c || o.humidity_pct !== s.humidity_pct;
  }).length;
  const merged = new Map([...old, ...incoming.map((s) => [s.time, s] as const)]);
  return { slots: sortSlots([...merged.values()]), changed };
}

// 睡眠中の温湿度の要約。日次ノートのプロパティになる
export interface NightClimate {
  avg_temperature_c: number;
  min_temperature_c: number;
  max_temperature_c: number;
  avg_humidity_pct: number;
  readings: number;
}

// 就寝〜起床の間に、1 時間あたり平均でこの件数以上の読み取り値があるときだけ要約する。
// 送信が何時間も止まった夜の値を、残った数件だけで代表させないため（30 分おきなら 2 件/時）
export const MIN_READINGS_PER_HOUR = 1;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;

interface TimedReading {
  at: number;
  temperature_c: number;
  humidity_pct: number;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

// sorted（時刻の昇順）の中で、at が t 以上になる最初の位置
function lowerBound(sorted: TimedReading[], t: number): number {
  // 二分探索の範囲そのものがループの制御なので let にする
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid]!.at < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// sorted は時刻の昇順。夜の始まりを二分探索で求め、終わりまでだけを見る
function summarize(sorted: TimedReading[], startMs: number, endMs: number): NightClimate | null {
  if (!(endMs > startMs)) return null;
  const inNight = sorted.slice(lowerBound(sorted, startMs), lowerBound(sorted, endMs + 1));
  const required = Math.max(
    1,
    Math.floor(((endMs - startMs) / MS_PER_HOUR) * MIN_READINGS_PER_HOUR),
  );
  if (inNight.length < required) return null;
  const temps = inNight.map((r) => r.temperature_c);
  return {
    avg_temperature_c: round(mean(temps), 1),
    min_temperature_c: Math.min(...temps),
    max_temperature_c: Math.max(...temps),
    avg_humidity_pct: round(mean(inNight.map((r) => r.humidity_pct)), 0),
    readings: inNight.length,
  };
}

/**
 * 夜ごとの温湿度を求める。nights は起床日と就寝・起床の時刻（オフセット付き ISO）。
 * 時刻が無い・不正な夜や、読み取り値が足りない夜は結果に含めない
 */
export function summarizeNights(
  nights: { date: string; start?: string | null; end?: string | null }[],
  readings: RoomReading[],
): Map<string, NightClimate> {
  // 時刻は先に 1 度だけ数値にして並べ、夜ごとには二分探索で範囲を切り出す
  const timed = readings
    .map((r) => ({
      at: Date.parse(r.time),
      temperature_c: r.temperature_c,
      humidity_pct: r.humidity_pct,
    }))
    // 手で直された文書などで時刻が不正（NaN）な値は、並べ替えと二分探索を崩すので先に除く
    .filter((r) => Number.isFinite(r.at))
    .sort((a, b) => a.at - b.at);
  return new Map(
    nights.flatMap((n) => {
      const start = n.start ? Date.parse(n.start) : Number.NaN;
      const end = n.end ? Date.parse(n.end) : Number.NaN;
      if (Number.isNaN(start) || Number.isNaN(end)) return [];
      const climate = summarize(timed, start, end);
      return climate ? [[n.date, climate] as const] : [];
    }),
  );
}
