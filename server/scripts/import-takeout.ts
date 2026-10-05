import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { type DailySummary, DailySummarySchema } from "../src/domain/daily.js";
import { isRealDate } from "../src/domain/dates.js";
import { buildDays } from "../src/takeout/index.js";
import { loadTakeout } from "../src/takeout/load.js";
import { checkApiToken, checkApiUrl, describeError, scrubToken } from "./cli-guard.js";

const DEFAULT_OUT = "out/takeout-days.json";
const DEFAULT_BATCH = 300;

// pnpm 12 は `pnpm run x -- --opt` の `--` もそのまま渡すので取り除く
const argv = process.argv.slice(2);
if (argv[0] === "--") argv.shift();

const { values } = parseArgs({
  args: argv,
  options: {
    // Takeout の Fit フォルダ。--takeout か環境変数 TAKEOUT_DIR で指定する
    takeout: { type: "string", default: process.env.TAKEOUT_DIR },
    out: { type: "string", default: DEFAULT_OUT },
    from: { type: "string" },
    to: { type: "string" },
    post: { type: "boolean", default: false },
    "api-url": { type: "string" },
    // 1 回の POST で送る日数。受信時にノートも書き込むので、本番では小さめにする
    batch: { type: "string", default: String(DEFAULT_BATCH) },
    // 内容を表示する日（カンマ区切りの YYYY-MM-DD）。指定しなければ表示しない
    check: { type: "string" },
  },
});
const BATCH = Number(values.batch);

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

for (const k of ["from", "to"] as const) {
  const v = values[k];
  if (v !== undefined && !isRealDate(v)) fail(`--${k} は YYYY-MM-DD 形式で指定してください`);
}
if (!Number.isInteger(BATCH) || BATCH < 1 || BATCH > 400)
  fail("--batch は 1〜400 の整数で指定してください");
if (!values.takeout)
  fail("--takeout か環境変数 TAKEOUT_DIR で Takeout の Fit フォルダを指定してください");
if (values.post && !values["api-url"]) fail("--post には --api-url が必要です");
const token = process.env.API_TOKEN;
if (values.post) {
  const error = checkApiUrl(values["api-url"]) ?? checkApiToken(token);
  if (error) fail(error);
}

const { csvDays, segments, nutrition, files, nutritionFiles, dropped } = await loadTakeout(
  values.takeout,
);
const { days, sleepByDate } = buildDays(
  csvDays,
  segments,
  { from: values.from, to: values.to },
  nutrition,
);

// 全日を DailySummarySchema で検証
const invalid: string[] = [];
for (const d of days) {
  const r = DailySummarySchema.safeParse(d);
  if (!r.success)
    invalid.push(`${d.date}: ${r.error.issues[0]?.path.join(".")} ${r.error.issues[0]?.message}`);
}
if (invalid.length > 0) fail(`検証エラー ${invalid.length} 件\n${invalid.slice(0, 10).join("\n")}`);

await mkdir(dirname(values.out), { recursive: true });
await writeFile(values.out, `${JSON.stringify(days)}\n`, "utf8");

// --- 統計 ---
const has = (s: "activity" | "heart_rate" | "body" | "sleep" | "nutrition") =>
  days.filter((d) => d[s] !== undefined).length;
const inRange = (date: string) =>
  (!values.from || date >= values.from) && (!values.to || date <= values.to);
const nights = [...sleepByDate].filter(([date]) => inRange(date));
const bySource = new Map<string, { nights: number; withStages: number }>();
for (const [, c] of nights) {
  const s = bySource.get(c.source) ?? { nights: 0, withStages: 0 };
  s.nights++;
  if (c.hasStages) s.withStages++;
  bySource.set(c.source, s);
}
const stageCodes = new Map<number, number>();
for (const seg of segments) stageCodes.set(seg.stage, (stageCodes.get(seg.stage) ?? 0) + 1);

console.log(`sources: ${files.length} sleep files, ${segments.length} segments`);
console.log(
  `stage codes (segments): ${JSON.stringify(Object.fromEntries([...stageCodes].sort((a, b) => a[0] - b[0])))}`,
);
console.log(`days: ${days.length} (${days[0]?.date ?? "-"} .. ${days.at(-1)?.date ?? "-"})`);
console.log(
  `with section: activity=${has("activity")} heart_rate=${has("heart_rate")} body=${has("body")} sleep=${has("sleep")} nutrition=${has("nutrition")}`,
);
const nutritionDates = days.filter((d) => d.nutrition !== undefined).map((d) => d.date);
console.log(
  `nutrition: ${nutritionFiles.length} files, ${nutrition.length} items, ${nutritionDates.length} days (${nutritionDates[0] ?? "-"} .. ${nutritionDates.at(-1) ?? "-"})`,
);
if (dropped.sleep > 0 || dropped.nutrition > 0) {
  console.log(
    `dropped (invalid time): sleep segments=${dropped.sleep} nutrition items=${dropped.nutrition}`,
  );
}
console.log(
  `sleep nights: ${nights.length}, with stages: ${nights.filter(([, c]) => c.hasStages).length}`,
);
for (const [src, s] of [...bySource].sort((a, b) => b[1].nights - a[1].nights)) {
  console.log(`  ${src}: nights=${s.nights} withStages=${s.withStages}`);
}
const byDate = new Map<string, DailySummary>(days.map((d) => [d.date, d]));
const checkDates = (values.check ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
for (const date of checkDates) {
  const d = byDate.get(date);
  const src = sleepByDate.get(date)?.source;
  console.log(
    `${date}${src ? ` [sleep source: ${src}]` : ""}: ${d ? JSON.stringify(d) : "(no data)"}`,
  );
}
console.log(`wrote ${values.out}`);

// --- POST ---
if (values.post) {
  const url = `${values["api-url"]!.replace(/\/+$/, "")}/api/ingest`;
  for (let i = 0; i < days.length; i += BATCH) {
    const batch = days.slice(i, i + BATCH);
    const range = `days ${i + 1}-${i + batch.length}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ days: batch }),
      });
    } catch (e) {
      fail(`POST 失敗 (${range}): ${describeError(e, token)}`);
    }
    if (!res.ok) {
      const body = (await res.text()).slice(0, 500);
      fail(`POST 失敗 (${range}): ${res.status} ${scrubToken(body, token)}`);
    }
    console.log(`posted ${i + batch.length}/${days.length}`);
  }
}
