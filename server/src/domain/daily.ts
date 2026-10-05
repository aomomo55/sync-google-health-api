import { z } from "zod";
import { isRealDate } from "./dates.js";

// 上限は実在のデータを弾かないよう、人が取りうる値より十分大きくしてある（誤送信や桁違いを止めるため）
const num = (max: number) => z.number().min(0).max(max).nullable().optional();
const count = (max: number) => z.number().int().min(0).max(max).nullable().optional();
const isoDateTime = z.iso.datetime({ offset: true }).nullable().optional();

export const LIMITS = {
  steps: 200_000,
  distanceM: 500_000,
  kcal: 50_000,
  // 1 日の中の分数（Android は日の範囲に切り詰め、Takeout は日別の CSV）
  dayMinutes: 1440,
  heartPoints: 5_000,
  bpm: 300,
  weightKg: 500,
  pct: 100,
  grams: 5_000,
  // 睡眠は前日から続くため 1 日を超えうる
  sleepMinutes: 2880,
} as const;

export const ActivitySchema = z.strictObject({
  steps: count(LIMITS.steps),
  distance_m: num(LIMITS.distanceM),
  calories_kcal: num(LIMITS.kcal),
  move_minutes: num(LIMITS.dayMinutes),
  heart_points: num(LIMITS.heartPoints),
  vigorous_minutes: num(LIMITS.dayMinutes),
  walking_minutes: num(LIMITS.dayMinutes),
});

export const HeartRateSchema = z.strictObject({
  avg_bpm: num(LIMITS.bpm),
  max_bpm: num(LIMITS.bpm),
  min_bpm: num(LIMITS.bpm),
  resting_bpm: num(LIMITS.bpm),
});

export const BodySchema = z.strictObject({
  weight_kg: num(LIMITS.weightKg),
  body_fat_pct: num(LIMITS.pct),
});

export const NutritionSchema = z.strictObject({
  energy_kcal: num(LIMITS.kcal),
  protein_g: num(LIMITS.grams),
  fat_g: num(LIMITS.grams),
  carbs_g: num(LIMITS.grams),
});

export const SleepSchema = z
  .strictObject({
    start: isoDateTime,
    end: isoDateTime,
    asleep_minutes: num(LIMITS.sleepMinutes),
    in_bed_minutes: num(LIMITS.sleepMinutes),
    awake_minutes: num(LIMITS.sleepMinutes),
    deep_minutes: num(LIMITS.sleepMinutes),
    light_minutes: num(LIMITS.sleepMinutes),
    rem_minutes: num(LIMITS.sleepMinutes),
    nap_minutes: num(LIMITS.sleepMinutes),
  })
  .refine((s) => !s.start || !s.end || Date.parse(s.start) <= Date.parse(s.end), {
    message: "end は start 以降である必要があります",
    path: ["end"],
  });

export const DateSchema = z.string().refine(isRealDate, "YYYY-MM-DD 形式の実在する日付が必要です");

export const DailySummarySchema = z.strictObject({
  date: DateSchema,
  activity: ActivitySchema.optional(),
  heart_rate: HeartRateSchema.optional(),
  body: BodySchema.optional(),
  sleep: SleepSchema.optional(),
  nutrition: NutritionSchema.optional(),
  source: z.string().min(1).max(64).optional(),
});

export type DailySummary = z.infer<typeof DailySummarySchema>;

export const SECTIONS = ["activity", "heart_rate", "body", "sleep", "nutrition"] as const;
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
