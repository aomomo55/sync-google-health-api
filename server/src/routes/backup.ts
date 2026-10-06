import { Hono } from "hono";
import { backupFileName, encryptBackup } from "../backup/backup.js";
import type { HealthStore } from "../store/health-store.js";

// 保存されている全ての日を、age の公開鍵で暗号化して返す（GAS が 1 日 1 回取得して Google Drive に置く）
export function backupRoutes(
  store: HealthStore,
  recipient: string,
  now: () => Date = () => new Date(),
) {
  const r = new Hono();

  r.get("/health", async (c) => {
    const createdAt = now();
    const days = await store.getAllDays();
    const encrypted = await encryptBackup(days, recipient, createdAt);
    // Hono が受け付ける Uint8Array<ArrayBuffer> にそろえる
    return c.body(new Uint8Array(encrypted), 200, {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${backupFileName(createdAt)}"`,
      "Cache-Control": "no-store",
      // 中身は暗号化されているので、取得した側が件数を確かめられるようにする
      "X-Backup-Days": String(days.length),
    });
  });

  return r;
}
