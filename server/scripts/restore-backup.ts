import { readFileSync, statSync } from "node:fs";
import { parseArgs } from "node:util";
import { BackupTooLargeError, decryptBackup, MAX_BACKUP_JSON_BYTES } from "../src/backup/backup.js";
import { type CouchdbConnection, loadCouchdbConnection } from "../src/config.js";
import { CouchStore } from "../src/store/couch-store.js";

// バックアップ（health-YYYY-MM-DD.json.gz.age）を復号し、空の CouchDB の DB に書き戻す。
// 本番の DB には直接書かない。書き戻した DB を確かめてから、COUCHDB_HEALTH_DB を切り替える（docs/backup.md）
// 1 回の書き込みで送る日数
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
function failUnreadable(e: unknown, path: string, option: string): never {
  const code = (e as NodeJS.ErrnoException).code ?? "";
  return fail(`${option} のファイルを読めません（${code}）: ${path}`);
}

function readOrFail(path: string, option: string): Buffer {
  try {
    return readFileSync(path);
  } catch (e) {
    return failUnreadable(e, path, option);
  }
}

const identity = readOrFail(values.identity, "--identity")
  .toString("utf8")
  .split(/\r?\n/)
  .map((l) => l.trim())
  .find((l) => l.startsWith("AGE-SECRET-KEY-"));
if (!identity) fail("--identity のファイルに age の秘密鍵（AGE-SECRET-KEY-...）が見つかりません");

// 復号はファイル全体をメモリに読んでから行うので、解凍後の上限より大きいファイルは読む前に止める
// （圧縮と暗号化の後のファイルは、解凍後の JSON より十分小さい）
const fileSize = (() => {
  try {
    return statSync(values.file).size;
  } catch (e) {
    return failUnreadable(e, values.file, "--file");
  }
})();
if (fileSize > MAX_BACKUP_JSON_BYTES) {
  fail(
    `バックアップを読み込めません: ファイルが大きすぎます（${fileSize} バイト）: ${values.file}`,
  );
}

const backup = await decryptBackup(
  new Uint8Array(readOrFail(values.file, "--file")),
  identity,
).catch((e: unknown) =>
  fail(
    e instanceof BackupTooLargeError
      ? `バックアップを読み込めません: ${e.message}`
      : `バックアップを復号できません（鍵が違うか、ファイルが壊れています）: ${e instanceof Error ? e.message : String(e)}`,
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
// サーバーと同じ規則で検査する（http: で資格情報を外へ流さない、URL に資格情報を含めない）。
// メッセージには値を含めない
function loadConnectionOrFail(): CouchdbConnection {
  try {
    return loadCouchdbConnection();
  } catch (e) {
    return fail(
      `${e instanceof Error ? e.message : String(e)}\n環境変数 COUCHDB_URL / COUCHDB_USER / COUCHDB_PASSWORD を確認してください`,
    );
  }
}
const { COUCHDB_URL, COUCHDB_USER, COUCHDB_PASSWORD } = loadConnectionOrFail();

const store = new CouchStore({
  baseUrl: COUCHDB_URL,
  user: COUCHDB_USER,
  password: COUCHDB_PASSWORD,
  db,
});
await store.ensureReady();
// 既存のデータとマージしたり、別用途の DB に書き込んだりしないよう、文書が 1 件も無い DB にだけ書く
const existingDocs = await store.countDocs();
if (existingDocs > 0) {
  fail(`DB "${db}" には既に ${existingDocs} 件の文書があります。空の DB を指定してください`);
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
