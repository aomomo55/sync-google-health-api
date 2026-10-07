import { SLEEP_GOAL_KEY, STEP_GOAL_KEY } from "./daily.js";
import { notePaths } from "./paths.js";

// Obsidian Bases (.base) は YAML。式は YAML 上で文字列として書く
// 参考: https://obsidian.md/help/bases/syntax

// 「直近」の表の日数。ダッシュボードのグラフと、表を埋め込むときのビュー名でも使う
export const RECENT_DAYS = 90;
export const RECENT_DAYS_VIEW = `直近${RECENT_DAYS}日`;
export const RECENT_NIGHTS_VIEW = `直近${RECENT_DAYS}夜`;
const RECENT_FILTER = `'note.日付 >= today() - "${RECENT_DAYS}d"'`;

const DAILY_FILTERS = (dir: string) => `filters:
  and:
    - file.inFolder("${dir}")
    - 'type == "health-daily"'
`;

export function renderDailyLogBase(root?: string): string {
  const p = notePaths(root);
  return `${DAILY_FILTERS(p.dailyDir)}properties:
  note.日付:
    displayName: 日付
views:
  - type: table
    name: ${RECENT_DAYS_VIEW}
    filters:
      and:
        - ${RECENT_FILTER}
    order:
      - note.日付
      - note.曜日
      - note.歩数
      - note.距離km
      - note.運動時間
      - note.摂取カロリー
      - note.平均心拍
      - note.体重kg
      - note.${STEP_GOAL_KEY}
    sort:
      - property: note.日付
        direction: DESC
  - type: table
    name: 全期間
    order:
      - note.日付
      - note.曜日
      - note.歩数
      - note.距離km
      - note.運動時間
      - note.摂取カロリー
      - note.平均心拍
      - note.体重kg
      - note.${STEP_GOAL_KEY}
    sort:
      - property: note.日付
        direction: DESC
`;
}

export function renderSleepLogBase(root?: string): string {
  const p = notePaths(root);
  return `${DAILY_FILTERS(p.dailyDir)}views:
  - type: table
    name: ${RECENT_NIGHTS_VIEW}
    filters:
      and:
        - 'note.睡眠時間h'
        - ${RECENT_FILTER}
    order:
      - note.日付
      - note.就寝時刻
      - note.起床時刻
      - note.睡眠時間h
      - note.ベッド内時間h
      - note.深い睡眠分
      - note.浅い睡眠分
      - note.REM睡眠分
      - note.中途覚醒分
      - note.仮眠分
      - note.${SLEEP_GOAL_KEY}
    sort:
      - property: note.日付
        direction: DESC
`;
}

export function renderMonthlyBase(root?: string): string {
  const p = notePaths(root);
  return `filters:
  and:
    - file.inFolder("${p.monthlyDir}")
    - 'type == "health-monthly"'
views:
  - type: table
    name: 月次サマリー
    order:
      - note.月初日
      - note.計測日数
      - note.平均歩数
      - note.総距離km
      - note.運動時間合計
      - note.平均消費カロリー
      - note.平均摂取カロリー
      - note.平均心拍
      - note.平均体重kg
      - note.平均睡眠時間h
      - note.平均就寝時刻
      - note.平均起床時刻
    sort:
      - property: note.月初日
        direction: DESC
`;
}
