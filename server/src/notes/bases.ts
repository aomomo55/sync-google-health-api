import { notePaths } from "./paths.js";

// Obsidian Bases (.base) は YAML。式は YAML 上で文字列として書く
// 参考: https://obsidian.md/help/bases/syntax

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
    name: 直近90日
    filters:
      and:
        - 'note.日付 >= today() - "90d"'
    order:
      - note.日付
      - note.曜日
      - note.歩数
      - note.距離km
      - note.運動時間
      - note.平均心拍
      - note.体重kg
      - note.8000歩達成
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
      - note.平均心拍
      - note.体重kg
      - note.8000歩達成
    sort:
      - property: note.日付
        direction: DESC
`;
}

export function renderSleepLogBase(root?: string): string {
  const p = notePaths(root);
  return `${DAILY_FILTERS(p.dailyDir)}views:
  - type: table
    name: 直近90夜
    filters:
      and:
        - 'note.睡眠時間h'
        - 'note.日付 >= today() - "90d"'
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
      - note.7時間以上
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
