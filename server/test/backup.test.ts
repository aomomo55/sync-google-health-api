import { gzipSync } from "node:zlib";
import { Encrypter, generateIdentity, identityToRecipient } from "age-encryption";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  backupFileName,
  decryptBackup,
  encryptBackup,
  isAgeRecipient,
} from "../src/backup/backup.js";
import { loadConfig } from "../src/config.js";
import type { DailySummary } from "../src/domain/daily.js";
import { MemoryStore } from "../src/store/memory-store.js";

const API_TOKEN = "a".repeat(32);
const BACKUP_TOKEN = "b".repeat(32);
const identity = await generateIdentity();
const recipient = await identityToRecipient(identity);

const days: DailySummary[] = [
  { date: "2026-01-01", activity: { steps: 1234 } },
  { date: "2026-01-02", body: { weight_kg: 60.5 }, sleep: { asleep_minutes: 420 } },
];

describe("encryptBackup / decryptBackup", () => {
  it("暗号化したものを秘密鍵で戻せる", async () => {
    const data = await encryptBackup(days, recipient, new Date("2026-01-03T00:00:00Z"));
    const restored = await decryptBackup(data, identity);
    expect(restored.createdAt).toBe("2026-01-03T00:00:00.000Z");
    expect(restored.days).toEqual(days);
    expect(restored.invalid).toEqual([]);
  });

  it("暗号化されたデータに平文の値が含まれない", async () => {
    const data = await encryptBackup(days, recipient, new Date());
    expect(Buffer.from(data).toString("latin1")).not.toContain("2026-01-01");
  });

  it("別の秘密鍵では戻せない", async () => {
    const data = await encryptBackup(days, recipient, new Date());
    await expect(decryptBackup(data, await generateIdentity())).rejects.toThrow();
  });

  it("形の検証に通らない日は除き、理由とともに返す", async () => {
    const payload = {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      createdAt: "2026-01-03T00:00:00.000Z",
      days: [days[0], { date: "day:broken" }, { date: "2026-01-04", activity: { steps: -1 } }],
    };
    const e = new Encrypter();
    e.addRecipient(recipient);
    const data = await e.encrypt(new Uint8Array(gzipSync(JSON.stringify(payload))));
    const restored = await decryptBackup(data, identity);
    expect(restored.days).toEqual([days[0]]);
    expect(restored.invalid.map((i) => [i.index, i.date])).toEqual([
      [1, "day:broken"],
      [2, "2026-01-04"],
    ]);
  });

  it("形式が違うファイルは throw", async () => {
    const e = new Encrypter();
    e.addRecipient(recipient);
    const data = await e.encrypt(new Uint8Array(gzipSync(JSON.stringify({ format: "other" }))));
    await expect(decryptBackup(data, identity)).rejects.toThrow();
  });
});

describe("backupFileName", () => {
  it("日付は Asia/Tokyo の暦日", () => {
    expect(backupFileName(new Date("2026-10-05T15:30:00Z"))).toBe("health-2026-10-06.json.gz.age");
    expect(backupFileName(new Date("2026-10-05T14:30:00Z"))).toBe("health-2026-10-05.json.gz.age");
  });
});

describe("GET /backup/health", () => {
  const store = new MemoryStore();
  beforeAll(() => store.upsertDays(days));
  const app = createApp({
    config: { API_TOKEN, BACKUP_TOKEN, BACKUP_AGE_RECIPIENT: recipient },
    store,
  });

  it("BACKUP_TOKEN で暗号化された全期間を返す", async () => {
    const res = await app.request("/backup/health", {
      headers: { Authorization: `Bearer ${BACKUP_TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toMatch(
      /health-\d{4}-\d{2}-\d{2}\.json\.gz\.age/,
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-backup-days")).toBe("2");
    const restored = await decryptBackup(new Uint8Array(await res.arrayBuffer()), identity);
    expect(restored.days).toEqual(days);
  });

  it("API_TOKEN ではバックアップを取れない", async () => {
    const res = await app.request("/backup/health", {
      headers: { Authorization: `Bearer ${API_TOKEN}` },
    });
    expect(res.status).toBe(401);
  });

  it("BACKUP_TOKEN では /api を使えない", async () => {
    const res = await app.request("/api/ping", {
      headers: { Authorization: `Bearer ${BACKUP_TOKEN}` },
    });
    expect(res.status).toBe(401);
  });

  it("トークンなしは 401", async () => {
    expect((await app.request("/backup/health")).status).toBe(401);
  });

  it("設定が無ければ経路が無い（404）", async () => {
    const plain = createApp({ config: { API_TOKEN }, store });
    const res = await plain.request("/backup/health", {
      headers: { Authorization: `Bearer ${BACKUP_TOKEN}` },
    });
    expect(res.status).toBe(404);
  });
});

describe("loadConfig（バックアップ）", () => {
  const base = {
    API_TOKEN,
    COUCHDB_URL: "http://localhost:5984",
    COUCHDB_USER: "u",
    COUCHDB_PASSWORD: "p",
  };

  it("両方設定すれば読める", () => {
    const c = loadConfig({ ...base, BACKUP_TOKEN, BACKUP_AGE_RECIPIENT: recipient });
    expect(c.BACKUP_TOKEN).toBe(BACKUP_TOKEN);
    expect(c.BACKUP_AGE_RECIPIENT).toBe(recipient);
  });

  it("片方だけなら throw", () => {
    expect(() => loadConfig({ ...base, BACKUP_TOKEN })).toThrow(/BACKUP_TOKEN/);
    expect(() => loadConfig({ ...base, BACKUP_AGE_RECIPIENT: recipient })).toThrow(/BACKUP_TOKEN/);
  });

  it("API_TOKEN と同じ値は throw", () => {
    expect(() =>
      loadConfig({ ...base, BACKUP_TOKEN: API_TOKEN, BACKUP_AGE_RECIPIENT: recipient }),
    ).toThrow(/API_TOKEN と別の値/);
  });

  it("age の公開鍵でなければ throw（秘密鍵を入れた場合も含む）", () => {
    expect(() =>
      loadConfig({ ...base, BACKUP_TOKEN, BACKUP_AGE_RECIPIENT: "age1invalid" }),
    ).toThrow(/BACKUP_AGE_RECIPIENT/);
    expect(isAgeRecipient(identity)).toBe(false);
  });

  it("BACKUP_TOKEN に制御文字があると throw", () => {
    expect(() =>
      loadConfig({ ...base, BACKUP_TOKEN: `${BACKUP_TOKEN}\x1b`, BACKUP_AGE_RECIPIENT: recipient }),
    ).toThrow(/BACKUP_TOKEN/);
  });
});
