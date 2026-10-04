import { z } from "zod";
import { isRealDate } from "./dates.js";

const num = z.number().min(0).nullable().optional();
const isoDateTime = z.iso.datetime({ offset: true }).nullable().optional();

export const ActivitySchema = z.strictObject({
  steps: num,
  distance_m: num,
  calories_kcal: num,
  move_minutes: num,
  heart_points: num,
  vigorous_minutes: num,
  walking_minutes: num,
});

export const HeartRateSchema = z.strictObject({
  avg_bpm: num,
  max_bpm: num,
  min_bpm: num,
  resting_bpm: num,
});

export const BodySchema = z.strictObject({
  weight_kg: num,
  body_fat_pct: num,
});

export const SleepSchema = z.strictObject({
  start: isoDateTime,
  end: isoDateTime,
  asleep_minutes: num,
  in_bed_minutes: num,
  awake_minutes: num,
  deep_minutes: num,
  light_minutes: num,
  rem_minutes: num,
  nap_minutes: num,
});

export const DateSchema = z.string().refine(isRealDate, "YYYY-MM-DD 形式の実在する日付が必要です");

export const DailySummarySchema = z.strictObject({
  date: DateSchema,
  activity: ActivitySchema.optional(),
  heart_rate: HeartRateSchema.optional(),
  body: BodySchema.optional(),
  sleep: SleepSchema.optional(),
  source: z.string().min(1).max(64).optional(),
});

export type DailySummary = z.infer<typeof DailySummarySchema>;

export const SECTIONS = ["activity", "heart_rate", "body", "sleep"] as const;
export type Section = (typeof SECTIONS)[number];

// セクション単位の浅いマージ。incoming に存在するキー（null含む）が上書きする
export function mergeDay(existing: DailySummary | undefined, incoming: DailySummary): DailySummary {
  const out: Record<string, unknown> = {
    ...(existing ?? {}),
    date: incoming.date,
  };
  for (const s of SECTIONS) {
    const inc = incoming[s];
    if (inc !== undefined) out[s] = { ...(existing?.[s] ?? {}), ...inc };
  }
  if (incoming.source !== undefined) out.source = incoming.source;
  return out as DailySummary;
}

export function pickSections(day: DailySummary, types: Section[]): DailySummary {
  const out: DailySummary = { date: day.date };
  for (const s of types) {
    if (day[s] !== undefined) Object.assign(out, { [s]: day[s] });
  }
  return out;
}
