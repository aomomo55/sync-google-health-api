import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { decryptBackup } from "../src/backup/backup.js";
import { CouchStore } from "../src/store/couch-store.js";

// バックアップ（health-YYYY-MM-DD.json.gz.age）を復号し、空の CouchDB の DB に書き戻す。
// 本番の DB には直接書かない。書き戻した DB を確かめてから、COUCHDB_HEALTH_DB を切り替える（docs/backup.md）
const BATCH = 200;

// pnpm 12 は `pnpm run x -- --opt` の `--` もそのまま渡すので取り除く
const argv = process.argv.slice(2);
if (argv[0] === "--") argv.shift();

const { values } = parseArgs({
  args: argv,
  options: {
    file: { type: "string" },
    // age の秘密鍵のファイル（age-keygen の出力）。中身は表示しない
    identity: { type: "string" },
    db: { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
});

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

if (!values.file) fail("--file にバックアップのファイルを指定してください");
if (!values.identity) fail("--identity に age の秘密鍵のファイルを指定してください");

// 読めないときはスタックトレースではなく、どの引数のファイルかが分かるメッセージで止める
function readOrFail(path: string, option: string): Buffer {
  try {
    return readFileSync(path);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? "";
    return fail(`${option} のファイルを読めません（${code}）: ${path}`);
  }
}

const identity = readOrFail(values.identity, "--identity")
  .toString("utf8")
  .split(/\r?\n/)
  .map((l) => l.trim())
  .find((l) => l.startsWith("AGE-SECRET-KEY-"));
if (!identity) fail("--identity のファイルに age の秘密鍵（AGE-SECRET-KEY-...）が見つかりません");

const backup = await decryptBackup(
  new Uint8Array(readOrFail(values.file, "--file")),
  identity,
).catch((e: unknown) =>
  fail(
    `バックアップを復号できません（鍵が違うか、ファイルが壊れています）: ${e instanceof Error ? e.message : String(e)}`,
  ),
);

const first = backup.days.at(0)?.date ?? "-";
const last = backup.days.at(-1)?.date ?? "-";
console.log(`作成日時: ${backup.createdAt}`);
console.log(`日数: ${backup.days.length}（${first} 〜 ${last}）`);
for (const i of backup.invalid) {
  console.error(`  形が不正なため除外: ${i.index} 番目 ${i.date ?? "(日付なし)"}: ${i.reason}`);
}
if (values["dry-run"]) process.exit(backup.invalid.length > 0 ? 1 : 0);

const db = values.db;
// CouchDB の DB 名の規則
if (!db || !/^[a-z][a-z0-9_$()+/-]*$/.test(db)) {
  fail("--db に書き戻し先の DB 名（英小文字で始まる。例: health_restore）を指定してください");
}
const { COUCHDB_URL, COUCHDB_USER, COUCHDB_PASSWORD } = process.env;
if (!COUCHDB_URL || !COUCHDB_USER || !COUCHDB_PASSWORD) {
  fail("環境変数 COUCHDB_URL / COUCHDB_USER / COUCHDB_PASSWORD を設定してください");
}

const store = new CouchStore({
  baseUrl: COUCHDB_URL,
  user: COUCHDB_USER,
  password: COUCHDB_PASSWORD,
  db,
});
await store.ensureReady();
// 既存のデータとマージしてしまわないよう、空の DB にだけ書く
if ((await store.findAdjacentDate("0000-01-01", "next")) !== null) {
  fail(`DB "${db}" には既にデータがあります。空の DB を指定してください`);
}

const batches = Array.from({ length: Math.ceil(backup.days.length / BATCH) }, (_, n) =>
  backup.days.slice(n * BATCH, (n + 1) * BATCH),
);
const writtenCounts: number[] = [];
for (const batch of batches) {
  const { written } = await store.upsertDays(batch);
  writtenCounts.push(written);
  console.log(`書き戻し ${writtenCounts.reduce((a, b) => a + b, 0)}/${backup.days.length}`);
}
console.log(`完了: DB "${db}" に ${backup.days.length} 日分を書き戻しました`);
if (backup.invalid.length > 0) process.exit(1);
