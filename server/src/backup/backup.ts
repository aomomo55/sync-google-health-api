import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import { Decrypter, Encrypter } from "age-encryption";
import { z } from "zod";
import { type DailySummary, DailySummaryShapeSchema } from "../domain/daily.js";
import { issuePath } from "../shared/issue-path.js";

// バックアップの形式: JSON → gzip → age（公開鍵で暗号化）。
// 復号には手元の秘密鍵が要るので、サーバー・GAS・Google Drive のどこから漏れても中身は読めない
export const BACKUP_FORMAT = "sync-google-health-backup";
export const BACKUP_VERSION = 1;

// 解凍後の JSON の上限。1 日分は全項目を桁の多い数値で埋めても約 1 KB なので、100 年分（約 3.7 万日）
// でも 40 MB ほどに収まる。その 3 倍ほどの余裕を取り、小さなファイルが巨大に膨らむ圧縮爆弾で
// メモリを使い切る前に止める
export const MAX_BACKUP_JSON_BYTES = 128 * 1024 * 1024;
const BYTES_PER_MIB = 1024 * 1024;

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

// 解凍後のサイズが上限を超えた。鍵の誤りやファイルの破損とは対処が違うので、別の型で投げる
export class BackupTooLargeError extends Error {
  constructor() {
    super(`解凍後のサイズが上限（${MAX_BACKUP_JSON_BYTES / BYTES_PER_MIB} MiB）を超えています`);
    this.name = "BackupTooLargeError";
  }
}

async function gunzipWithLimit(compressed: Uint8Array): Promise<Buffer> {
  try {
    return await gunzipAsync(compressed, { maxOutputLength: MAX_BACKUP_JSON_BYTES });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
      throw new BackupTooLargeError();
    }
    throw e;
  }
}

export interface BackupPayload {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  createdAt: string;
  days: DailySummary[];
}

const PayloadSchema = z.object({
  format: z.literal(BACKUP_FORMAT),
  version: z.literal(BACKUP_VERSION),
  createdAt: z.string(),
  // 日ごとの検証は decryptBackup で行い、壊れた日があっても他の日は復元できるようにする
  days: z.array(z.unknown()),
});

// age の受信者（公開鍵）として使えるか。設定の検査に使う
export function isAgeRecipient(s: string): boolean {
  try {
    new Encrypter().addRecipient(s);
    return true;
  } catch {
    return false;
  }
}

export async function encryptBackup(
  days: DailySummary[],
  recipient: string,
  createdAt: Date,
): Promise<Uint8Array> {
  const payload: BackupPayload = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: createdAt.toISOString(),
    days,
  };
  const compressed = await gzipAsync(JSON.stringify(payload));
  const encrypter = new Encrypter();
  encrypter.addRecipient(recipient);
  return encrypter.encrypt(new Uint8Array(compressed));
}

export interface DecryptedBackup {
  createdAt: string;
  days: DailySummary[];
  // 形の検証に通らなかった日（何番目か と理由）。復元はこれを除いて行う
  invalid: { index: number; date: string | null; reason: string }[];
}

export async function decryptBackup(data: Uint8Array, identity: string): Promise<DecryptedBackup> {
  const decrypter = new Decrypter();
  decrypter.addIdentity(identity);
  const compressed = await decrypter.decrypt(data);
  const json: unknown = JSON.parse((await gunzipWithLimit(compressed)).toString("utf8"));
  const payload = PayloadSchema.parse(json);
  const results = payload.days.map((d, index) => ({
    index,
    raw: d,
    r: DailySummaryShapeSchema.safeParse(d),
  }));
  return {
    createdAt: payload.createdAt,
    days: results.flatMap(({ r }) => (r.success ? [r.data] : [])),
    invalid: results.flatMap(({ index, raw, r }) =>
      r.success
        ? []
        : [
            {
              index,
              date:
                typeof (raw as { date?: unknown })?.date === "string"
                  ? (raw as { date: string }).date
                  : null,
              reason: r.error.issues.map((i) => `${issuePath(i)}: ${i.message}`).join("、"),
            },
          ],
    ),
  };
}

// Google Drive に置くファイル名。日付は Asia/Tokyo の暦日
export function backupFileName(createdAt: Date): string {
  const date = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(createdAt);
  return `health-${date}.json.gz.age`;
}
