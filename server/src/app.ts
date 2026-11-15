import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { HTTPException } from "hono/http-exception";
import type { Config } from "./config.js";
import { backupRoutes } from "./routes/backup.js";
import { healthRoutes } from "./routes/health.js";
import { roomRoutes } from "./routes/room.js";
import type { HealthStore } from "./store/health-store.js";
import type { RoomStore } from "./store/room-store.js";
import { NoteSync } from "./sync/note-sync.js";
import { noteRootFromPrefix, type VaultWriter } from "./vault/vault-writer.js";

// 書き込みを許可したフォルダ（VAULT_HEALTH_PREFIX）の下にノートを生成する NoteSync を作る。
// 検証と生成で別のフォルダを使うと、すべての書き込みが拒否される
export function createNoteSync(deps: {
  store: HealthStore & RoomStore;
  writer: VaultWriter;
  prefix: string;
}): NoteSync {
  return new NoteSync({
    store: deps.store,
    room: deps.store,
    writer: deps.writer,
    root: noteRootFromPrefix(deps.prefix),
  });
}

export interface AppDeps {
  config: Pick<Config, "API_TOKEN" | "BACKUP_TOKEN" | "BACKUP_AGE_RECIPIENT" | "ROOM_TOKEN">;
  store: HealthStore & RoomStore;
  noteSync?: NoteSync | null;
}

export function createApp({ config, store, noteSync = null }: AppDeps) {
  const app = new Hono();

  app.get("/healthz", (c) => c.json({ status: "ok" }));

  const api = new Hono();
  api.use("*", bearerAuth({ token: config.API_TOKEN }));
  api.get("/ping", (c) => c.json({ pong: true }));
  api.route("/", healthRoutes(store, noteSync));
  app.route("/api", api);

  // バックアップは API_TOKEN では取れず、BACKUP_TOKEN では /api を使えないよう、経路ごと分ける。
  // 設定が無ければ経路を作らない（404）
  if (config.BACKUP_TOKEN && config.BACKUP_AGE_RECIPIENT) {
    const backup = new Hono();
    backup.use("*", bearerAuth({ token: config.BACKUP_TOKEN }));
    backup.route("/", backupRoutes(store, config.BACKUP_AGE_RECIPIENT));
    app.route("/backup", backup);
  }

  // 寝室の温湿度の受信も、ROOM_TOKEN だけで使える経路に分ける（ADR 0033）。設定が無ければ経路を作らない
  if (config.ROOM_TOKEN) {
    const room = new Hono();
    room.use("*", bearerAuth({ token: config.ROOM_TOKEN }));
    room.route("/", roomRoutes(store));
    app.route("/room", room);
  }

  app.notFound((c) => c.json({ error: "Not Found" }, 404));

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      // WWW-Authenticate は MCP コネクタの OAuth 開始に必要なので引き継ぐ
      const wwwAuthenticate = err.getResponse().headers.get("WWW-Authenticate");
      if (wwwAuthenticate) c.header("WWW-Authenticate", wwwAuthenticate);
      const message = err.message || (err.status === 401 ? "Unauthorized" : "Error");
      return c.json({ error: message }, err.status);
    }
    // スタックトレースはレスポンスに含めない
    console.error(err);
    return c.json({ error: "Internal Server Error" }, 500);
  });

  return app;
}
