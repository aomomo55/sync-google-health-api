import type { MonthlySummary } from "../domain/monthly.js";
import { fmtDuration, fmtNum, monthLabelJa, numOrNull, shiftMonth } from "./format.js";
import { linkTarget, notePaths } from "./paths.js";
import { frontmatter, type YamlEntry } from "./yaml.js";

function rnd(x: number | null): number | null {
  return x === null ? null : Math.round(x);
}

export function monthlyEntries(m: MonthlySummary): YamlEntry[] {
  return [
    { key: "type", value: "health-monthly" },
    { key: "月", value: m.month, quote: true },
    { key: "月初日", value: `${m.month}-01`, raw: true },
    { key: "計測日数", value: m.days_with_data },
    { key: "平均歩数", value: numOrNull(m.activity.avg_steps) },
    { key: "総距離km", value: numOrNull(m.activity.total_distance_km) },
    { key: "運動時間合計", value: numOrNull(m.activity.total_move_minutes) },
    { key: "ウォーキング分合計", value: rnd(numOrNull(m.activity.total_walking_minutes)) },
    { key: "平均心拍", value: numOrNull(m.heart_rate.avg_bpm) },
    { key: "平均体重kg", value: numOrNull(m.body.avg_weight_kg) },
    { key: "睡眠記録日数", value: m.sleep.nights },
    { key: "平均睡眠時間h", value: numOrNull(m.sleep.avg_asleep_hours) },
    { key: "平均ベッド内時間h", value: numOrNull(m.sleep.avg_in_bed_hours) },
    { key: "平均就寝時刻", value: m.sleep.avg_bedtime, quote: true },
    { key: "平均起床時刻", value: m.sleep.avg_wake_time, quote: true },
    { key: "仮眠合計分", value: numOrNull(m.sleep.total_nap_minutes) },
    { key: "平均深い睡眠分", value: numOrNull(m.sleep.avg_deep_minutes) },
    { key: "平均浅い睡眠分", value: numOrNull(m.sleep.avg_light_minutes) },
    { key: "平均REM睡眠分", value: numOrNull(m.sleep.avg_rem_minutes) },
  ];
}

function summaryLines(m: MonthlySummary): string[] {
  const lines: string[] = [`- 計測日数: ${m.days_with_data}日`];
  const a = m.activity;
  const act: string[] = [];
  if (a.avg_steps !== null) act.push(`平均 ${fmtNum(a.avg_steps)}歩/日`);
  if (a.total_distance_km !== null) act.push(`合計 ${fmtNum(a.total_distance_km)} km`);
  if (a.total_move_minutes !== null) act.push(`運動 ${fmtDuration(a.total_move_minutes)}`);
  if (act.length > 0) lines.push(`- 活動: ${act.join(" / ")}`);
  if (m.heart_rate.avg_bpm !== null) lines.push(`- 平均心拍: ${fmtNum(m.heart_rate.avg_bpm)} bpm`);
  if (m.body.avg_weight_kg !== null) lines.push(`- 平均体重: ${fmtNum(m.body.avg_weight_kg)} kg`);
  const s = m.sleep;
  if (s.nights > 0) {
    const parts: string[] = [`${s.nights}夜`];
    if (s.avg_asleep_hours !== null) parts.push(`平均 ${fmtNum(s.avg_asleep_hours)} 時間`);
    if (s.avg_bedtime && s.avg_wake_time) parts.push(`${s.avg_bedtime} → ${s.avg_wake_time}`);
    lines.push(`- 睡眠: ${parts.join(" / ")}`);
  }
  return lines;
}

export function renderMonthlyNote(m: MonthlySummary, root?: string): string {
  const p = notePaths(root);
  const prev = shiftMonth(m.month, -1);
  const next = shiftMonth(m.month, 1);
  const query = [
    "TABLE 歩数, 距離km, 運動時間, 平均心拍, 睡眠時間h, 就寝時刻, 起床時刻",
    `FROM "${p.dailyDir}"`,
    `WHERE type = "health-daily" AND dateformat(日付, "yyyy-MM") = "${m.month}"`,
    "SORT 日付 ASC",
  ].join("\n");
  return [
    frontmatter(monthlyEntries(m), ["health/monthly"]),
    `# ${monthLabelJa(m.month)}の健康サマリー\n`,
    `${summaryLines(m).join("\n")}\n`,
    `← [[${linkTarget(p.monthly(prev))}|${monthLabelJa(prev)}]] | [[${linkTarget(p.monthly(next))}|${monthLabelJa(next)}]] →\n`,
    "## 日別一覧\n",
    "```dataview\n" + query + "\n```\n",
  ].join("\n");
}
