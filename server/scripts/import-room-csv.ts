import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { z } from "zod";
import { MAX_ROOM_READINGS } from "../src/routes/room.js";
import { checkApiToken, checkApiUrl, describeError, REQUEST_TIMEOUT_MS } from "./cli-guard.js";
import { parseRoomCsv } from "./room-csv.js";

// 寝室の温湿度計の CSV を読み、POST /room/readings へ送る（ADR 0033）。
// --api-url を付けなければ、読み取った件数と期間を表示するだけで送らない
const DEFAULT_BATCH = 1000;
const MAX_LISTED_INVALID = 20;
const MAX_ERROR_BODY_CHARS = 200;
const TOKEN_ENV = "ROOM_TOKEN";

const responseSchema = z.object({ written: z.number(), unchanged: z.number() });

// pnpm 12 は `pnpm run x -- --opt` の `--` もそのまま渡すので取り除く
const argv = process.argv.slice(2);
if (argv[0] === "--") argv.shift();

const { values } = parseArgs({
  args: argv,
  options: {
    file: { type: "string" },
    "api-url": { type: "string" },
    batch: { type: "string", default: String(DEFAULT_BATCH) },
  },
});

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const batch = Number(values.batch);
if (!Number.isInteger(batch) || batch < 1 || batch > MAX_ROOM_READINGS) {
  fail(`--batch は 1〜${MAX_ROOM_READINGS} の整数で指定してください`);
}
const file = values.file ?? fail("--file に CSV のパスを指定してください");
const apiUrl = values["api-url"];
const token = process.env[TOKEN_ENV];
if (apiUrl !== undefined) {
  const error = checkApiUrl(apiUrl) ?? checkApiToken(token, TOKEN_ENV);
  if (error) fail(error);
}

const text = await readFile(file, "utf8").catch(() => fail(`--file を読めません: ${file}`));
const parsed = (() => {
  try {
    return parseRoomCsv(text);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
})();
const { readings, invalid } = parsed;

const times = readings.map((r) => r.time).sort();
console.log(
  `読み取り: ${readings.length} 件${times.length > 0 ? `（${times[0]} 〜 ${times.at(-1)}）` : ""} / 不正な行: ${invalid.length} 件`,
);
for (const v of invalid.slice(0, MAX_LISTED_INVALID)) console.error(`  ${v.line} 行目: ${v.error}`);

if (apiUrl === undefined || !token) {
  console.log("--api-url が無いので送信しません");
  process.exit(invalid.length > 0 ? 1 : 0);
}

const endpoint = `${apiUrl.replace(/\/+$/, "")}/room/readings`;
const batches = Array.from({ length: Math.ceil(readings.length / batch) }, (_, i) =>
  readings.slice(i * batch, (i + 1) * batch),
);

// 送り直しても結果は同じ（同じ分の値は置き換える）なので、失敗したらそこで止め、もう一度実行してもらう
const totals = { written: 0, unchanged: 0 };
for (const [i, chunk] of batches.entries()) {
  const label = `${i + 1}/${batches.length}（${chunk[0]?.time} 〜 ${chunk.at(-1)?.time}）`;
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ readings: chunk }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, MAX_ERROR_BODY_CHARS)}`);
    }
    const json = responseSchema.parse(await res.json());
    totals.written += json.written;
    totals.unchanged += json.unchanged;
    console.log(`${label}: 書き込み ${json.written} / 変更なし ${json.unchanged}`);
  } catch (e) {
    fail(`${label}: エラー ${describeError(e, token)}（もう一度実行すると、続きから送り直せます）`);
  }
}
console.log(`合計: 書き込み ${totals.written} / 変更なし ${totals.unchanged}`);
if (invalid.length > 0) process.exit(1);
