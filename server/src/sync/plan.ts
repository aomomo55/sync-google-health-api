import type { DailySummary } from "../domain/daily.js";
import { isRealDate } from "../domain/dates.js";
import { summarizeMonth } from "../domain/monthly.js";
import {
  mergeMemo,
  notePaths,
  renderAllStaticNotes,
  renderDailyNote,
  renderMonthlyNote,
} from "../notes/index.js";

export interface PlanItem {
  path: string;
  // 既存ノート（無ければ null）から書き込む内容を作る
  render(existing: string | null): string;
}

export interface AffectedNotes {
  dates: string[];
  months: string[];
}

// 対象日のうちデータのある日と、その直前・直後の日（前日/翌日リンクが変わる）
// days は日付昇順
export function affectedNotes(days: DailySummary[], targetDates: string[]): AffectedNotes {
  const index = new Map(days.map((d, i) => [d.date, i]));
  const dates = new Set<string>();
  for (const t of targetDates) {
    const i = index.get(t);
    if (i === undefined) continue;
    for (const j of [i - 1, i, i + 1]) {
      const d = days[j];
      if (d) dates.add(d.date);
    }
  }
  const sorted = [...dates].sort();
  return {
    dates: sorted,
    months: [...new Set(sorted.map((d) => d.slice(0, 7)))],
  };
}

// 実在する YYYY-MM-DD の日と、そうでない日に分ける（順序は保つ）
export function splitValidDays(days: DailySummary[]): {
  valid: DailySummary[];
  invalid: DailySummary[];
} {
  const valid: DailySummary[] = [];
  const invalid: DailySummary[] = [];
  for (const d of days)
    (typeof d.date === "string" && isRealDate(d.date) ? valid : invalid).push(d);
  return { valid, invalid };
}

// 純粋関数。days は日付昇順で、影響を受ける月の全日を含むこと。
// 不正な日付の日はノートのパスや YAML に入らないよう除く
export function planNotes(
  allDays: DailySummary[],
  targetDates: string[],
  root?: string,
  opts: { includeStatic?: boolean } = {},
): PlanItem[] {
  const days = splitValidDays(allDays).valid;
  const p = notePaths(root);
  const { dates, months } = affectedNotes(days, targetDates);
  const byDate = new Map(days.map((d, i) => [d.date, i]));
  const items: PlanItem[] = [];

  for (const date of dates) {
    const i = byDate.get(date)!;
    const day = days[i]!;
    const nav = { prev: days[i - 1]?.date, next: days[i + 1]?.date };
    items.push({
      path: p.daily(date),
      render: (existing) => mergeMemo(existing, renderDailyNote(day, nav, root)),
    });
  }

  for (const month of months) {
    const content = renderMonthlyNote(
      summarizeMonth(
        month,
        days.filter((d) => d.date.startsWith(month)),
      ),
      root,
    );
    items.push({ path: p.monthly(month), render: () => content });
  }

  if (opts.includeStatic) {
    for (const n of renderAllStaticNotes(root)) {
      items.push({ path: n.path, render: () => n.content });
    }
  }
  return items;
}
