import { renderDailyLogBase, renderMonthlyBase, renderSleepLogBase } from "./bases.js";
import { renderHealthDashboard, renderSleepDashboard } from "./dashboards.js";
import { notePaths } from "./paths.js";

export { renderDailyLogBase, renderMonthlyBase, renderSleepLogBase } from "./bases.js";
export {
  type DailyNav,
  MEMO_MARKER,
  MemoMarkerMissingError,
  mergeMemo,
  renderDailyNote,
} from "./daily.js";
export { renderHealthDashboard, renderSleepDashboard } from "./dashboards.js";
export { renderMonthlyNote } from "./monthly.js";
export { DEFAULT_ROOT, type NotePaths, notePaths } from "./paths.js";

export interface NoteFile {
  path: string;
  content: string;
}

// データに依存しない静的ファイル（ダッシュボードと Bases）
export function renderAllStaticNotes(root?: string): NoteFile[] {
  const p = notePaths(root);
  return [
    { path: p.dashboard, content: renderHealthDashboard(root) },
    { path: p.sleepDashboard, content: renderSleepDashboard(root) },
    { path: p.dailyBase, content: renderDailyLogBase(root) },
    { path: p.sleepBase, content: renderSleepLogBase(root) },
    { path: p.monthlyBase, content: renderMonthlyBase(root) },
  ];
}
