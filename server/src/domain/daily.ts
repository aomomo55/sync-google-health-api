import { z } from "zod";
import { issuePath } from "../shared/issue-path.js";
import { isRealDate, MINUTES_PER_DAY } from "./dates.js";

// 上限は実在のデータを弾かないよう、人が取りうる値より十分大きくしてある（誤送信や桁違いを止めるため）
export const LIMITS = {
  steps: 200_000,
  distanceM: 500_000,
  kcal: 50_000,
  // 1 日の中の分数（Android は日の範囲に切り詰め、Takeout は日別の CSV）
  dayMinutes: MINUTES_PER_DAY,
  heartPoints: 5_000,
  bpm: 300,
  weightKg: 500,
  pct: 100,
  grams: 5_000,
  // 睡眠は前日から続くため 1 日を超えうる
  sleepMinutes: 2 * MINUTES_PER_DAY,
} as const;

// 検証は 2 段に分ける（ADR 0012）。
// 形の検証（キー・型・形式・負の数）に反する日はリクエスト全体を拒否し、
// 範囲の検証（上限・整数・睡眠の前後）に反する日はその日だけを拒否する
function buildSchemas(withRanges: boolean) {
  const nonNegative = () => z.number().min(0, "0 以上である必要があります");
  const num = (max: number) =>
    (withRanges ? nonNegative().max(max, `${max} 以下である必要があります`) : nonNegative())
      .nullable()
      .optional();
  const count = (max: number) =>
    (withRanges
      ? nonNegative().int("整数である必要があります").max(max, `${max} 以下である必要があります`)
      : nonNegative()
    )
      .nullable()
      .optional();
  const isoDateTime = z.iso.datetime({ offset: true }).nullable().optional();

  const activity = z.strictObject({
    steps: count(LIMITS.steps),
    distance_m: num(LIMITS.distanceM),
    calories_kcal: num(LIMITS.kcal),
    move_minutes: num(LIMITS.dayMinutes),
    heart_points: num(LIMITS.heartPoints),
    vigorous_minutes: num(LIMITS.dayMinutes),
    walking_minutes: num(LIMITS.dayMinutes),
  });

  const heartRate = z.strictObject({
    avg_bpm: num(LIMITS.bpm),
    max_bpm: num(LIMITS.bpm),
    min_bpm: num(LIMITS.bpm),
    resting_bpm: num(LIMITS.bpm),
  });

  const body = z.strictObject({
    weight_kg: num(LIMITS.weightKg),
    body_fat_pct: num(LIMITS.pct),
  });

  const nutrition = z.strictObject({
    energy_kcal: num(LIMITS.kcal),
    protein_g: num(LIMITS.grams),
    fat_g: num(LIMITS.grams),
    carbs_g: num(LIMITS.grams),
  });

  const sleepShape = z.strictObject({
    start: isoDateTime,
    end: isoDateTime,
    asleep_minutes: num(LIMITS.sleepMinutes),
    in_bed_minutes: num(LIMITS.sleepMinutes),
    awake_minutes: num(LIMITS.sleepMinutes),
    deep_minutes: num(LIMITS.sleepMinutes),
    light_minutes: num(LIMITS.sleepMinutes),
    rem_minutes: num(LIMITS.sleepMinutes),
    nap_minutes: num(LIMITS.sleepMinutes),
  });
  // 受け取ったデータの中だけで比べる。保存済みの値とマージした後の前後関係は保証しない
  const sleep = withRanges
    ? sleepShape.refine((s) => !s.start || !s.end || Date.parse(s.start) <= Date.parse(s.end), {
        message: "start 以降である必要があります",
        path: ["end"],
      })
    : sleepShape;

  const day = z.strictObject({
    date: DateSchema,
    activity: activity.optional(),
    heart_rate: heartRate.optional(),
    body: body.optional(),
    sleep: sleep.optional(),
    nutrition: nutrition.optional(),
    source: z.string().min(1).max(64).optional(),
  });
  return { activity, heartRate, body, nutrition, sleep, day };
}

export const DateSchema = z.string().refine(isRealDate, "YYYY-MM-DD 形式の実在する日付が必要です");

const full = buildSchemas(true);
export const ActivitySchema = full.activity;
export const HeartRateSchema = full.heartRate;
export const BodySchema = full.body;
export const NutritionSchema = full.nutrition;
export const SleepSchema = full.sleep;

// 範囲まで含めた検証
export const DailySummarySchema = full.day;
// 形だけの検証（上限・整数・睡眠の前後を見ない）
export const DailySummaryShapeSchema = buildSchemas(false).day;

// 範囲の検証に反する項目を日本語で返す。問題が無ければ null
export function checkDayRanges(day: unknown): string | null {
  const r = DailySummarySchema.safeParse(day);
  if (r.success) return null;
  const fields = new Map<string, string>();
  for (const i of r.error.issues) {
    const path = issuePath(i);
    if (!fields.has(path)) fields.set(path, i.message);
  }
  return `範囲外の値があります: ${[...fields].map(([p, m]) => `${p}（${m}）`).join("、")}`;
}

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
