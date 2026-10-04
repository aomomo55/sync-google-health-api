import type { DailySummary } from "./daily.js";

export interface MonthlySummary {
  month: string;
  days_with_data: number;
  activity: {
    avg_steps: number | null;
    total_distance_km: number | null;
    total_move_minutes: number | null;
    total_walking_minutes: number | null;
  };
  heart_rate: { avg_bpm: number | null };
  body: { avg_weight_kg: number | null };
  sleep: {
    nights: number;
    avg_asleep_hours: number | null;
    avg_in_bed_hours: number | null;
    avg_bedtime: string | null;
    avg_wake_time: string | null;
    total_nap_minutes: number | null;
    avg_deep_minutes: number | null;
    avg_light_minutes: number | null;
    avg_rem_minutes: number | null;
  };
}

const JST_OFFSET_MS = 9 * 3600_000;

function round(x: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

function vals(xs: (number | null | undefined)[]): number[] {
  return xs.filter((x): x is number => typeof x === "number");
}

function avg(xs: number[]): number | null {
  return xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function sum(xs: number[]): number | null {
  return xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0);
}

function r(x: number | null, digits: number): number | null {
  return x === null ? null : round(x, digits);
}

// ISO 文字列を JST の 0:00 からの経過分に変換
function jstMinutes(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const d = new Date(t + JST_OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function formatHm(minutes: number): string {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

function avgBedtime(xs: number[]): string | null {
  // 12:00 より前は翌日扱いにして平均し、24h で巻き戻す
  const a = avg(xs.map((m) => (m < 720 ? m + 1440 : m)));
  return a === null ? null : formatHm(a);
}

function hasData(d: DailySummary): boolean {
  return [d.activity, d.heart_rate, d.body, d.sleep].some(
    (s) => s && Object.values(s).some((v) => v !== null && v !== undefined),
  );
}

export function summarizeMonth(month: string, days: DailySummary[]): MonthlySummary {
  const a = days.map((d) => d.activity);
  const sleepDays = days.flatMap((d) => (d.sleep ? [d.sleep] : []));
  const nights = sleepDays.filter(
    (s) => s.asleep_minutes != null || s.in_bed_minutes != null || s.start != null || s.end != null,
  ).length;
  const sleepAvg = (pick: (s: (typeof sleepDays)[number]) => number | null | undefined) =>
    avg(vals(sleepDays.map(pick)));

  const distanceM = sum(vals(a.map((x) => x?.distance_m)));
  const asleep = sleepAvg((s) => s.asleep_minutes);
  const inBed = sleepAvg((s) => s.in_bed_minutes);

  return {
    month,
    days_with_data: days.filter(hasData).length,
    activity: {
      avg_steps: r(avg(vals(a.map((x) => x?.steps))), 0),
      total_distance_km: distanceM === null ? null : round(distanceM / 1000, 2),
      total_move_minutes: sum(vals(a.map((x) => x?.move_minutes))),
      total_walking_minutes: sum(vals(a.map((x) => x?.walking_minutes))),
    },
    heart_rate: {
      avg_bpm: r(avg(vals(days.map((d) => d.heart_rate?.avg_bpm))), 1),
    },
    body: {
      avg_weight_kg: r(avg(vals(days.map((d) => d.body?.weight_kg))), 1),
    },
    sleep: {
      nights,
      avg_asleep_hours: asleep === null ? null : round(asleep / 60, 2),
      avg_in_bed_hours: inBed === null ? null : round(inBed / 60, 2),
      avg_bedtime: avgBedtime(vals(sleepDays.map((s) => jstMinutes(s.start)))),
      avg_wake_time: (() => {
        const w = avg(vals(sleepDays.map((s) => jstMinutes(s.end))));
        return w === null ? null : formatHm(w);
      })(),
      total_nap_minutes: sum(vals(sleepDays.map((s) => s.nap_minutes))),
      avg_deep_minutes: r(
        sleepAvg((s) => s.deep_minutes),
        1,
      ),
      avg_light_minutes: r(
        sleepAvg((s) => s.light_minutes),
        1,
      ),
      avg_rem_minutes: r(
        sleepAvg((s) => s.rem_minutes),
        1,
      ),
    },
  };
}

// 日次データを月ごとにまとめる。データのある月のみ昇順で返す
export function summarizeMonths(days: DailySummary[]): MonthlySummary[] {
  const groups = new Map<string, DailySummary[]>();
  for (const d of days) {
    const m = d.date.slice(0, 7);
    groups.set(m, [...(groups.get(m) ?? []), d]);
  }
  return [...groups.entries()]
    .sort(([x], [y]) => x.localeCompare(y))
    .map(([m, ds]) => summarizeMonth(m, ds))
    .filter((s) => s.days_with_data > 0);
}
