import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { RoomReadingSchema } from "../domain/room.js";
import { issuePath } from "../shared/issue-path.js";
import type { RoomStore } from "../store/room-store.js";

// 1 回の POST /room/readings で受け付ける件数。30 分おきなら約 41 日分。
// CLI（import:room-csv）のバッチの上限にも使う
export const MAX_ROOM_READINGS = 2000;
const MAX_ROOM_BODY_BYTES = 512 * 1024;
const MAX_REPORTED_ISSUES = 10;

const RoomReadingsSchema = z.strictObject({
  readings: z.array(RoomReadingSchema).min(1).max(MAX_ROOM_READINGS),
});

// 寝室の温湿度を受け取って保存する（ADR 0033）。ノートは作らない。
// 夜の温湿度は、睡眠のデータが届いて日次ノートを作り直すときに、保存済みの値から求める
export function roomRoutes(store: RoomStore) {
  const r = new Hono();

  r.post(
    "/readings",
    bodyLimit({
      maxSize: MAX_ROOM_BODY_BYTES,
      onError: (c) => c.json({ error: "Payload Too Large" }, 413),
    }),
    async (c) => {
      const raw: unknown = await c.req.json().catch(() => {
        throw new HTTPException(400, { message: "JSON が不正です" });
      });
      const parsed = RoomReadingsSchema.safeParse(raw);
      if (!parsed.success) {
        const details = parsed.error.issues
          .slice(0, MAX_REPORTED_ISSUES)
          .map((i) => `${issuePath(i)}: ${i.message}`)
          .join("; ");
        throw new HTTPException(400, { message: `リクエストが不正です: ${details}` });
      }
      const { written, unchanged } = await store.upsertReadings(parsed.data.readings);
      return c.json({ written, unchanged });
    },
  );

  return r;
}
