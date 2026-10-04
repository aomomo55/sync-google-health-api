import { parseArgs } from "node:util";
import { addDays, inclusiveDays, isRealDate } from "../src/domain/dates.js";

const DEFAULT_CHUNK_DAYS = 120;
const RETRY_DELAYS_MS = [5_000, 15_000, 30_000];

// pnpm 12 は `pnpm run x -- --opt` の `--` もそのまま渡すので取り除く
const argv = process.argv.slice(2);
if (argv[0] === "--") argv.shift();

const { values } = parseArgs({
  args: argv,
  options: {
    from: { type: "string" },
    to: { type: "string" },
    "include-static": { type: "boolean", default: false },
    "api-url": { type: "string" },
    // 1 回の同期で扱う日数。応答が遅いときは小さくする
    days: { type: "string", default: String(DEFAULT_CHUNK_DAYS) },
  },
});
const CHUNK_DAYS = Number(values.days);

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const { from, to } = values;
if (!from || !to || !isRealDate(from) || !isRealDate(to)) {
  fail("--from と --to を YYYY-MM-DD 形式で指定してください");
}
if (inclusiveDays(from, to) < 1) fail("--from は --to 以前である必要があります");
if (!Number.isInteger(CHUNK_DAYS) || CHUNK_DAYS < 1 || CHUNK_DAYS > 400) {
  fail("--days は 1〜400 の整数で指定してください");
}
const apiUrl = values["api-url"];
if (!apiUrl) fail("--api-url を指定してください");
const token = process.env.API_TOKEN;
if (!token) fail("環境変数 API_TOKEN が未設定です");

const endpoint = `${apiUrl.replace(/\/+$/, "")}/api/notes/sync`;

// fetch failed だけでは原因が分からないので、cause（タイムアウト、接続拒否など）も表示する
function describe(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const cause = e.cause as { code?: string; message?: string } | undefined;
  const detail = cause ? ` (${[cause.code, cause.message].filter(Boolean).join(": ")})` : "";
  return `${e.message}${detail}`;
}

// 同期は何度やり直しても同じ結果になるので、通信エラーと 5xx は待ってから再試行する
async function postWithRetry(body: unknown): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status < 500 || attempt >= RETRY_DELAYS_MS.length) return res;
      console.error(`  HTTP ${res.status}。再試行します`);
    } catch (e) {
      if (attempt >= RETRY_DELAYS_MS.length) throw e;
      console.error(`  ${describe(e)}。再試行します`);
    }
    await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
  }
}
let written = 0;
let unchanged = 0;
const failures: { path: string; error: string }[] = [];
let chunkError = false;

for (let start = from, first = true; start <= to; first = false) {
  const chunkEnd = addDays(start, CHUNK_DAYS - 1);
  const end = chunkEnd < to ? chunkEnd : to;
  const body = {
    from: start,
    to: end,
    ...(first && values["include-static"] ? { includeStatic: true } : {}),
  };
  try {
    const res = await postWithRetry(body);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as {
      written: number;
      unchanged: number;
      failed: { path: string; error: string }[];
    };
    written += json.written;
    unchanged += json.unchanged;
    failures.push(...json.failed);
    console.log(
      `${start}..${end}: 書き込み ${json.written} / 変更なし ${json.unchanged} / 失敗 ${json.failed.length}`,
    );
  } catch (e) {
    chunkError = true;
    console.error(`${start}..${end}: エラー ${describe(e)}`);
  }
  start = addDays(end, 1);
}

console.log(`合計: 書き込み ${written} / 変更なし ${unchanged} / 失敗 ${failures.length}`);
for (const f of failures.slice(0, 20)) console.error(`  失敗: ${f.path}: ${f.error}`);
if (failures.length > 0 || chunkError) process.exit(1);
