import { parseArgs } from "node:util";
import { addDays, inclusiveDays, isRealDate } from "../src/domain/dates.js";
import { MAX_SPAN_DAYS } from "../src/routes/health.js";
import { checkApiToken, checkApiUrl, describeError, scrubToken } from "./cli-guard.js";

const DEFAULT_CHUNK_DAYS = 120;
const RETRY_DELAYS_MS = [5_000, 15_000, 30_000];
// エラーの応答本文と、最後に一覧で表示する失敗の上限
const MAX_ERROR_BODY_CHARS = 200;
const MAX_LISTED_FAILURES = 20;

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
if (!Number.isInteger(CHUNK_DAYS) || CHUNK_DAYS < 1 || CHUNK_DAYS > MAX_SPAN_DAYS) {
  fail(`--days は 1〜${MAX_SPAN_DAYS} の整数で指定してください`);
}
const apiUrl = values["api-url"];
const urlError = checkApiUrl(apiUrl);
if (urlError || !apiUrl) fail(urlError ?? "--api-url を指定してください");
const token = process.env.API_TOKEN;
const tokenError = checkApiToken(token);
if (tokenError || !token) fail(tokenError ?? "環境変数 API_TOKEN が未設定です");

const endpoint = `${apiUrl.replace(/\/+$/, "")}/api/notes/sync`;

const describe = (e: unknown) => describeError(e, token);

// 同期は何度やり直しても同じ結果になるので、通信エラーと 5xx は待ってから再試行する
async function postWithRetry(body: unknown): Promise<Response> {
  // リトライの回数そのものがループの制御なので let にする
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
const chunkTotals: { written: number; unchanged: number }[] = [];
const failures: { path: string; error: string }[] = [];
const errorChunks: string[] = [];

// 区間の進行（start と first）そのものがループの制御なので let にする
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
    if (!res.ok)
      throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, MAX_ERROR_BODY_CHARS)}`);
    const json = (await res.json()) as {
      written: number;
      unchanged: number;
      failed: { path: string; error: string }[];
    };
    chunkTotals.push({ written: json.written, unchanged: json.unchanged });
    failures.push(...json.failed);
    console.log(
      `${start}..${end}: 書き込み ${json.written} / 変更なし ${json.unchanged} / 失敗 ${json.failed.length}`,
    );
  } catch (e) {
    errorChunks.push(`${start}..${end}`);
    console.error(`${start}..${end}: エラー ${describe(e)}`);
  }
  start = addDays(end, 1);
}

const written = chunkTotals.reduce((t, c) => t + c.written, 0);
const unchanged = chunkTotals.reduce((t, c) => t + c.unchanged, 0);
console.log(`合計: 書き込み ${written} / 変更なし ${unchanged} / 失敗 ${failures.length}`);
for (const f of failures.slice(0, MAX_LISTED_FAILURES))
  console.error(`  失敗: ${f.path}: ${scrubToken(f.error, token)}`);
if (failures.length > 0 || errorChunks.length > 0) process.exit(1);
