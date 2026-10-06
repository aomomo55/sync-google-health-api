import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import { Decrypter, Encrypter } from "age-encryption";
import { z } from "zod";
import { type DailySummary, DailySummaryShapeSchema } from "../domain/daily.js";

// バックアップの形式: JSON → gzip → age（公開鍵で暗号化）。
// 復号には手元の秘密鍵が要るので、サーバー・GAS・Google Drive のどこから漏れても中身は読めない
export const BACKUP_FORMAT = "sync-google-health-backup";
export const BACKUP_VERSION = 1;

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

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
  const json: unknown = JSON.parse((await gunzipAsync(compressed)).toString("utf8"));
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
              reason: r.error.issues
                .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
                .join("、"),
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
