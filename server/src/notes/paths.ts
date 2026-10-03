export const DEFAULT_ROOT = "Health";

export interface NotePaths {
  root: string;
  dailyDir: string;
  monthlyDir: string;
  daily(date: string): string;
  monthly(month: string): string;
  dashboard: string;
  sleepDashboard: string;
  dailyBase: string;
  sleepBase: string;
  monthlyBase: string;
}

export function notePaths(root: string = DEFAULT_ROOT): NotePaths {
  const r = root.replace(/^\/+|\/+$/g, "");
  return {
    root: r,
    dailyDir: `${r}/Daily`,
    monthlyDir: `${r}/Monthly`,
    daily: (date) => `${r}/Daily/${date}.md`,
    monthly: (month) => `${r}/Monthly/${month}.md`,
    dashboard: `${r}/ヘルスケアダッシュボード.md`,
    sleepDashboard: `${r}/睡眠ダッシュボード.md`,
    dailyBase: `${r}/_bases/日次ログ.base`,
    sleepBase: `${r}/_bases/睡眠ログ.base`,
    monthlyBase: `${r}/_bases/月次サマリー.base`,
  };
}

// wikilink 用（拡張子なし）
export function linkTarget(path: string): string {
  return path.replace(/\.(md)$/, "");
}
