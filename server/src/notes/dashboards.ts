import { GENERATED_NOTICE } from "./format.js";
import { linkTarget, notePaths } from "./paths.js";

// dataviewjs + Charts プラグイン (window.renderChart は Chart.js の設定オブジェクトをそのまま受け取る)
// 参考: https://github.com/phibr0/obsidian-charts/blob/master/src/chartRenderer.ts (renderRaw)

const COLORS = {
  blue: "#4e79a7",
  orange: "#f28e2b",
  red: "#e15759",
  teal: "#76b7b2",
  green: "#59a14f",
  purple: "#b07aa1",
  gray: "#999999",
};

// 各ブロック共通の前置き。テンプレート内で ${ やバッククォートは使わない
function prelude(): string {
  return `const el = this.container;
const num = (v) => (typeof v === "number" ? v : null);
const day = (p) => (p.日付 && p.日付.toFormat ? p.日付.toFormat("yyyy-MM-dd") : String(p.日付).slice(0, 10));
const month = (p) => (p.月初日 && p.月初日.toFormat ? p.月初日.toFormat("yyyy-MM") : String(p.月).slice(0, 7));
const draw = (config) => {
  if (!window.renderChart) { dv.paragraph("Charts プラグインが必要です"); return; }
  window.renderChart(config, el);
};
const line = (label, data, color, extra) => Object.assign({ label, data, borderColor: color, backgroundColor: color, tension: 0.2, pointRadius: 2, spanGaps: true }, extra || {});`;
}

// root は dataviewjs の文字列リテラルに埋め込む。使える文字は設定の検証で制限している
function dailyPages(root: string, count: number, unit: "days" | "nights"): string {
  const filter =
    unit === "days"
      ? `const cutoff = dv.date("today").minus({ days: ${count - 1} });
const pages = dv.pages('"${root}/Daily"')
  .where((p) => p.type === "health-daily" && p.日付 && p.日付 >= cutoff)
  .sort((p) => p.日付, "asc").array();`
      : `const pages = dv.pages('"${root}/Daily"')
  .where((p) => p.type === "health-daily" && p.日付 && num(p.睡眠時間h) !== null)
  .sort((p) => p.日付, "asc").array().slice(-${count});`;
  return filter;
}

function monthlyPages(root: string): string {
  return `const pages = dv.pages('"${root}/Monthly"')
  .where((p) => p.type === "health-monthly" && p.月初日)
  .sort((p) => p.月初日, "asc").array();`;
}

function block(body: string): string {
  return `\`\`\`dataviewjs\n${body}\n\`\`\`\n`;
}

function emptyGuard(msg: string): string {
  return `if (pages.length === 0) { dv.paragraph("${msg}"); } else {`;
}

export function renderHealthDashboard(root?: string): string {
  const p = notePaths(root);
  const r = p.root;

  const steps = block(`${prelude()}
${dailyPages(r, 90, "days")}
${emptyGuard("直近90日のデータがありません")}
  draw({
    type: "bar",
    data: {
      labels: pages.map(day),
      datasets: [
        { label: "歩数", data: pages.map((p) => num(p.歩数)), backgroundColor: "${COLORS.blue}" },
        { type: "line", label: "目標 8000", data: pages.map(() => 8000), borderColor: "${COLORS.red}", borderDash: [6, 4], pointRadius: 0, borderWidth: 1 },
      ],
    },
    options: { scales: { y: { beginAtZero: true } } },
  });
}`);

  const hr = block(`${prelude()}
${dailyPages(r, 90, "days")}
${emptyGuard("直近90日のデータがありません")}
  draw({
    type: "line",
    data: { labels: pages.map(day), datasets: [line("平均心拍", pages.map((p) => num(p.平均心拍)), "${COLORS.red}")] },
  });
}`);

  const weight = block(`${prelude()}
${dailyPages(r, 90, "days")}
const withWeight = pages.filter((p) => num(p.体重kg) !== null);
if (withWeight.length === 0) { dv.paragraph("直近90日の体重データがありません"); } else {
  draw({
    type: "line",
    data: { labels: withWeight.map(day), datasets: [line("体重kg", withWeight.map((p) => num(p.体重kg)), "${COLORS.green}")] },
  });
}`);

  const calories = block(`${prelude()}
${dailyPages(r, 90, "days")}
${emptyGuard("直近90日のデータがありません")}
  draw({
    type: "bar",
    data: {
      labels: pages.map(day),
      datasets: [
        { label: "摂取カロリー", data: pages.map((p) => num(p.摂取カロリー)), backgroundColor: "${COLORS.orange}" },
        { type: "line", label: "消費カロリー", data: pages.map((p) => num(p.消費カロリー)), borderColor: "${COLORS.blue}", backgroundColor: "${COLORS.blue}", tension: 0.2, pointRadius: 2, spanGaps: true },
      ],
    },
    options: { scales: { y: { beginAtZero: true, title: { display: true, text: "kcal" } } } },
  });
}`);

  const monthlyCalories = block(`${prelude()}
${monthlyPages(r)}
const rows = pages.filter((p) => num(p.平均消費カロリー) !== null || num(p.平均摂取カロリー) !== null);
if (rows.length === 0) { dv.paragraph("月次データがありません"); } else {
  draw({
    type: "bar",
    data: {
      labels: rows.map(month),
      datasets: [
        { label: "平均摂取カロリー", data: rows.map((p) => num(p.平均摂取カロリー)), backgroundColor: "${COLORS.orange}" },
        { type: "line", label: "平均消費カロリー", data: rows.map((p) => num(p.平均消費カロリー)), borderColor: "${COLORS.blue}", backgroundColor: "${COLORS.blue}", tension: 0.2, pointRadius: 2, spanGaps: true },
      ],
    },
    options: { scales: { y: { beginAtZero: true, title: { display: true, text: "kcal" } } } },
  });
}`);

  const monthly = (label: string, key: string, color: string, type: "bar" | "line") =>
    block(`${prelude()}
${monthlyPages(r)}
const rows = pages.filter((p) => num(p.${key}) !== null);
if (rows.length === 0) { dv.paragraph("月次データがありません"); } else {
  draw({
    type: "${type}",
    data: {
      labels: rows.map(month),
      datasets: [${type === "bar" ? `{ label: "${label}", data: rows.map((p) => num(p.${key})), backgroundColor: "${color}" }` : `line("${label}", rows.map((p) => num(p.${key})), "${color}")`}],
    },
  });
}`);

  return [
    "# ヘルスケアダッシュボード\n",
    GENERATED_NOTICE,
    "> [!info] データについて\n> Google Fit の Takeout と、Android アプリ経由の Health Connect のデータから自動生成・自動更新されます。\n> このノートは静的で、グラフと表は Dataview / Charts / Bases が Daily・Monthly ノートから描画します。\n",
    "## 直近90日\n",
    `![[${p.dailyBase}#直近90日]]\n`,
    "### 歩数\n",
    steps,
    "### 平均心拍\n",
    hr,
    "### 体重\n",
    weight,
    "## カロリー\n",
    "### 摂取と消費\n",
    calories,
    "## 月次の推移\n",
    "### 平均歩数\n",
    monthly("平均歩数", "平均歩数", COLORS.blue, "bar"),
    "### 平均心拍\n",
    monthly("平均心拍", "平均心拍", COLORS.red, "line"),
    "### 平均体重\n",
    monthly("平均体重kg", "平均体重kg", COLORS.green, "line"),
    "### 平均カロリー（摂取と消費）\n",
    monthlyCalories,
    `![[${p.monthlyBase}]]\n`,
    "## 睡眠\n",
    `[[${linkTarget(p.sleepDashboard)}|睡眠ダッシュボード]] を参照\n`,
  ].join("\n");
}

export function renderSleepDashboard(root?: string): string {
  const p = notePaths(root);
  const r = p.root;
  const hours = `const hm = (s) => {
  const m = /^(\\d{1,2}):(\\d{2})$/.exec(String(s || ""));
  return m ? Number(m[1]) + Number(m[2]) / 60 : null;
};
const bed = (s) => { const h = hm(s); return h === null ? null : (h < 12 ? h + 24 : h); };
const wake = (s) => { const h = hm(s); return h === null ? null : h + 24; };
const clock = (v) => { const m = Math.round((((v % 24) + 24) % 24) * 60); return Math.floor(m / 60) + ":" + String(m % 60).padStart(2, "0"); };
const timeAxis = { min: 20, max: 34, title: { display: true, text: "時刻" }, ticks: { stepSize: 2, autoSkip: false, callback: (v) => clock(v) } };`;
  // 起床は翌日扱い（+24）にして、就寝（下）→起床（上）と時間が一方向に進む軸にする。
  // 軸は 20:00〜翌10:00 に固定。外れる日が出てきたら範囲を広げる

  // 直近 7 日（暦日）の睡眠時間。記録の無い日も空けて並べ、7 時間の目安線を引く
  // 以下のテンプレート内は、ダッシュボードに出力する JavaScript の文字列（この TS のコードではない）
  const week = block(`${prelude()}
${dailyPages(r, 7, "days")}
const labels = [];
for (let i = 6; i >= 0; i--) labels.push(dv.date("today").minus({ days: i }).toFormat("yyyy-MM-dd"));
const byDay = new Map(pages.map((p) => [day(p), num(p.睡眠時間h)]));
const values = labels.map((d) => (byDay.has(d) ? byDay.get(d) : null));
if (values.every((v) => v === null)) { dv.paragraph("直近7日の睡眠データがありません"); } else {
  draw({
    type: "bar",
    data: {
      labels: labels.map((d) => d.slice(5)),
      datasets: [
        { label: "睡眠時間h", data: values, backgroundColor: "${COLORS.purple}" },
        { type: "line", label: "目標 7時間", data: labels.map(() => 7), borderColor: "${COLORS.red}", borderDash: [6, 4], pointRadius: 0, borderWidth: 1 },
      ],
    },
    options: { scales: { y: { beginAtZero: true, suggestedMax: 9, title: { display: true, text: "時間" } } } },
  });
}`);

  const stages = block(`${prelude()}
${dailyPages(r, 30, "nights")}
${emptyGuard("睡眠データがありません")}
  const stack = (label, key, color) => ({ label, data: pages.map((p) => num(p[key])), backgroundColor: color });
  draw({
    type: "bar",
    data: {
      labels: pages.map(day),
      datasets: [
        stack("深い睡眠", "深い睡眠分", "${COLORS.blue}"),
        stack("浅い睡眠", "浅い睡眠分", "${COLORS.teal}"),
        stack("REM睡眠", "REM睡眠分", "${COLORS.purple}"),
      ],
    },
    options: { scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true, title: { display: true, text: "分" } } } },
  });
}`);

  const times = block(`${prelude()}
${hours}
${dailyPages(r, 30, "nights")}
${emptyGuard("睡眠データがありません")}
  draw({
    type: "line",
    data: {
      labels: pages.map(day),
      datasets: [
        line("就寝時刻", pages.map((p) => bed(p.就寝時刻)), "${COLORS.purple}"),
        line("起床時刻", pages.map((p) => wake(p.起床時刻)), "${COLORS.orange}"),
      ],
    },
    options: { scales: { y: timeAxis } },
  });
}`);

  const awake = block(`${prelude()}
${dailyPages(r, 30, "nights")}
${emptyGuard("睡眠データがありません")}
  draw({
    type: "bar",
    data: { labels: pages.map(day), datasets: [{ label: "中途覚醒分", data: pages.map((p) => num(p.中途覚醒分)), backgroundColor: "${COLORS.orange}" }] },
    options: { scales: { y: { beginAtZero: true } } },
  });
}`);

  const monthlySleep = block(`${prelude()}
${monthlyPages(r)}
const rows = pages.filter((p) => num(p.平均睡眠時間h) !== null);
const values = rows.map((p) => num(p.平均睡眠時間h));
if (rows.length === 0) { dv.paragraph("月次データがありません"); } else {
  draw({
    type: "line",
    data: {
      labels: rows.map(month),
      datasets: [
        line("平均睡眠時間h", values, "${COLORS.blue}"),
        { type: "line", label: "目標 7時間", data: rows.map(() => 7), borderColor: "${COLORS.red}", borderDash: [6, 4], pointRadius: 0, borderWidth: 1 },
      ],
    },
    // 0 起点だと月ごとの差が見えないので、データの範囲に合わせる
    options: { scales: { y: { min: Math.floor(Math.min(...values, 7) - 0.5), max: Math.ceil(Math.max(...values, 7) + 0.5), title: { display: true, text: "時間" } } } },
  });
}`);

  const monthlyTimes = block(`${prelude()}
${hours}
${monthlyPages(r)}
const rows = pages.filter((p) => hm(p.平均就寝時刻) !== null || hm(p.平均起床時刻) !== null);
if (rows.length === 0) { dv.paragraph("月次データがありません"); } else {
  draw({
    type: "line",
    data: {
      labels: rows.map(month),
      datasets: [
        line("平均就寝時刻", rows.map((p) => bed(p.平均就寝時刻)), "${COLORS.purple}"),
        line("平均起床時刻", rows.map((p) => wake(p.平均起床時刻)), "${COLORS.orange}"),
      ],
    },
    options: { scales: { y: timeAxis } },
  });
}`);

  return [
    "# 睡眠ダッシュボード\n",
    GENERATED_NOTICE,
    `[[${linkTarget(p.dashboard)}|ヘルスケアダッシュボード]] に戻る\n`,
    "## 直近1週間の睡眠時間\n",
    week,
    "## 直近90夜\n",
    `![[${p.sleepBase}#直近90夜]]\n`,
    "### 睡眠ステージ（直近30夜）\n",
    stages,
    "### 就寝・起床時刻（直近30夜）\n",
    times,
    "### 中途覚醒（直近30夜）\n",
    awake,
    "## 月次の推移\n",
    "### 平均睡眠時間\n",
    monthlySleep,
    "### 平均就寝・起床時刻\n",
    monthlyTimes,
  ].join("\n");
}
