import type { DailySummary } from "../domain/daily.js";
import { round } from "../shared/rounding.js";
import { fmtDuration, fmtNum, jstHm, monthLabelJa, numOrNull, weekdayJa } from "./format.js";
import { linkTarget, notePaths } from "./paths.js";
import { frontmatter, type YamlEntry } from "./yaml.js";

export const MEMO_MARKER = "%% health:memo — この行より下は自動更新で上書きされません %%";
const MEMO_MARKER_RE = /^%% health:memo/m;

export const STEP_GOAL = 8000;
export const SLEEP_GOAL_MINUTES = 420;
export const SLEEP_GOAL_HOURS = SLEEP_GOAL_MINUTES / 60;
// 目標を達成したかのプロパティ名。Bases の列やダッシュボードの目標線と同じ目標から作る。
// 目標を変えるとプロパティ名も変わり、同期し直していない既存のノートには古い名前が残る
export const STEP_GOAL_KEY = `${STEP_GOAL}歩達成`;
export const SLEEP_GOAL_KEY = `${SLEEP_GOAL_HOURS}時間以上`;

export interface DailyNav {
  prev?: string;
  next?: string;
}

function scaled(x: number | null | undefined, div: number, digits: number): number | null {
  const n = numOrNull(x);
  return n === null ? null : round(n / div, digits);
}

function int(x: number | null | undefined): number | null {
  const n = numOrNull(x);
  return n === null ? null : Math.round(n);
}

function rounded(x: number | null | undefined, digits: number): number | null {
  const n = numOrNull(x);
  return n === null ? null : round(n, digits);
}

export function dailyEntries(day: DailySummary): YamlEntry[] {
  const a = day.activity;
  const h = day.heart_rate;
  const b = day.body;
  const s = day.sleep;
  const n = day.nutrition;
  const steps = numOrNull(a?.steps);
  const asleep = numOrNull(s?.asleep_minutes);
  return [
    { key: "type", value: "health-daily" },
    { key: "日付", value: day.date, raw: true },
    { key: "曜日", value: weekdayJa(day.date) },
    { key: "歩数", value: int(a?.steps) },
    { key: "距離km", value: scaled(a?.distance_m, 1000, 2) },
    { key: "消費カロリー", value: int(a?.calories_kcal) },
    { key: "摂取カロリー", value: int(n?.energy_kcal) },
    { key: "たんぱく質g", value: rounded(n?.protein_g, 1) },
    { key: "脂質g", value: rounded(n?.fat_g, 1) },
    { key: "炭水化物g", value: rounded(n?.carbs_g, 1) },
    { key: "運動時間", value: numOrNull(a?.move_minutes) },
    { key: "強めの運動", value: numOrNull(a?.vigorous_minutes) },
    { key: "ハートポイント", value: numOrNull(a?.heart_points) },
    { key: "ウォーキング分", value: int(a?.walking_minutes) },
    { key: "平均心拍", value: rounded(h?.avg_bpm, 1) },
    { key: "最大心拍", value: numOrNull(h?.max_bpm) },
    { key: "最小心拍", value: numOrNull(h?.min_bpm) },
    { key: "安静時心拍", value: numOrNull(h?.resting_bpm) },
    { key: "体重kg", value: numOrNull(b?.weight_kg) },
    { key: "体脂肪率", value: numOrNull(b?.body_fat_pct) },
    { key: "就寝時刻", value: jstHm(s?.start), quote: true },
    { key: "起床時刻", value: jstHm(s?.end), quote: true },
    { key: "睡眠時間h", value: scaled(s?.asleep_minutes, 60, 2) },
    { key: "ベッド内時間h", value: scaled(s?.in_bed_minutes, 60, 2) },
    { key: "中途覚醒分", value: numOrNull(s?.awake_minutes) },
    { key: "深い睡眠分", value: numOrNull(s?.deep_minutes) },
    { key: "浅い睡眠分", value: numOrNull(s?.light_minutes) },
    { key: "REM睡眠分", value: numOrNull(s?.rem_minutes) },
    { key: "仮眠分", value: numOrNull(s?.nap_minutes) },
    { key: STEP_GOAL_KEY, value: steps === null ? null : steps >= STEP_GOAL },
    { key: SLEEP_GOAL_KEY, value: asleep === null ? null : asleep >= SLEEP_GOAL_MINUTES },
  ];
}

function summaryLines(day: DailySummary): string[] {
  const lines: string[] = [];
  const a = day.activity;
  const h = day.heart_rate;
  const s = day.sleep;
  const b = day.body;

  const act: string[] = [];
  const steps = numOrNull(a?.steps);
  if (steps !== null) act.push(`${fmtNum(Math.round(steps))}歩`);
  const km = scaled(a?.distance_m, 1000, 2);
  if (km !== null) act.push(`${fmtNum(km)} km`);
  const move = numOrNull(a?.move_minutes);
  if (move !== null) act.push(`運動 ${fmtDuration(move)}`);
  if (act.length > 0) lines.push(`- 活動: ${act.join(" / ")}`);

  const kcal = int(day.nutrition?.energy_kcal);
  const pfc = [
    ["P", rounded(day.nutrition?.protein_g, 1)],
    ["F", rounded(day.nutrition?.fat_g, 1)],
    ["C", rounded(day.nutrition?.carbs_g, 1)],
  ].flatMap(([label, v]) => (v === null ? [] : [`${label} ${fmtNum(v as number)}g`]));
  if (kcal !== null || pfc.length > 0) {
    const text =
      kcal === null
        ? pfc.join(" / ")
        : `${fmtNum(kcal)} kcal${pfc.length > 0 ? `（${pfc.join(" / ")}）` : ""}`;
    lines.push(`- 食事: ${text}`);
  }

  const avg = numOrNull(h?.avg_bpm);
  const min = numOrNull(h?.min_bpm);
  const max = numOrNull(h?.max_bpm);
  if (avg !== null || min !== null || max !== null) {
    const parts: string[] = [];
    if (avg !== null) parts.push(`平均 ${fmtNum(round(avg, 1))} bpm`);
    if (min !== null && max !== null) parts.push(`${fmtNum(min)}〜${fmtNum(max)}`);
    else if (min !== null) parts.push(`最小 ${fmtNum(min)}`);
    else if (max !== null) parts.push(`最大 ${fmtNum(max)}`);
    lines.push(`- 心拍: ${parts.join(" / ")}`);
  }

  const start = jstHm(s?.start);
  const end = jstHm(s?.end);
  const asleep = numOrNull(s?.asleep_minutes);
  if (start || end || asleep !== null) {
    const parts: string[] = [];
    if (start && end) parts.push(`${start} → ${end}`);
    else if (start) parts.push(`就寝 ${start}`);
    else if (end) parts.push(`起床 ${end}`);
    if (asleep !== null) parts.push(`睡眠 ${fmtDuration(asleep)}`);
    const stages: string[] = [];
    const deep = numOrNull(s?.deep_minutes);
    const light = numOrNull(s?.light_minutes);
    const rem = numOrNull(s?.rem_minutes);
    if (deep !== null) stages.push(`深い ${deep}分`);
    if (light !== null) stages.push(`浅い ${light}分`);
    if (rem !== null) stages.push(`REM ${rem}分`);
    if (stages.length > 0) parts.push(`内訳 ${stages.join("・")}`);
    lines.push(`- 睡眠: ${parts.join(" / ")}`);
  }
  const nap = numOrNull(s?.nap_minutes);
  if (nap !== null) lines.push(`- 仮眠: ${fmtDuration(nap)}`);

  const w = numOrNull(b?.weight_kg);
  if (w !== null) lines.push(`- 体重: ${fmtNum(w)} kg`);
  return lines;
}

export function renderDailyNote(day: DailySummary, nav: DailyNav = {}, root?: string): string {
  const p = notePaths(root);
  const month = day.date.slice(0, 7);
  const parts: string[] = [
    frontmatter(dailyEntries(day), ["health/daily"]),
    `# ${day.date}（${weekdayJa(day.date)}）\n`,
  ];
  const summary = summaryLines(day);
  if (summary.length > 0) parts.push(`${summary.join("\n")}\n`);

  const links: string[] = [];
  if (nav.prev) links.push(`← [[${linkTarget(p.daily(nav.prev))}|前日]]`);
  links.push(`[[${linkTarget(p.monthly(month))}|${monthLabelJa(month)}]]`);
  if (nav.next) links.push(`[[${linkTarget(p.daily(nav.next))}|翌日]] →`);
  parts.push(`${links.join(" | ")}\n`);

  parts.push(`${MEMO_MARKER}\n## メモ\n`);
  return parts.join("\n");
}

// 既存ノートにメモ欄のマーカーが無く、上書きすると利用者の文章を失うおそれがある
export class MemoMarkerMissingError extends Error {
  constructor() {
    super(
      "既存のノートにメモ欄のマーカー（%% health:memo の行）が無いため、上書きしませんでした。マーカーの行を戻すか、ノートを削除すると再生成されます",
    );
    this.name = "MemoMarkerMissingError";
  }
}

// 再生成時にユーザーのメモ（マーカー以降）を保持する。
// 空でない既存ノートにマーカーが無ければ MemoMarkerMissingError を投げる
export function mergeMemo(existing: string | null, generated: string): string {
  if (existing === null || existing.trim() === "") return generated;
  const genMatch = MEMO_MARKER_RE.exec(generated);
  if (!genMatch) return generated;
  const exMatch = MEMO_MARKER_RE.exec(existing);
  if (!exMatch) throw new MemoMarkerMissingError();
  return generated.slice(0, genMatch.index) + existing.slice(exMatch.index);
}
