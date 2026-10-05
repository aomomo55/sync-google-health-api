import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { CouchStore } from "./store/couch-store.js";
import { createNoteSync } from "./sync/note-sync.js";
import { createVaultWriter } from "./vault/index.js";

const config = loadConfig();
const store = new CouchStore({
  baseUrl: config.COUCHDB_URL,
  user: config.COUCHDB_USER,
  password: config.COUCHDB_PASSWORD,
  db: config.COUCHDB_HEALTH_DB,
});
await store.ensureReady();
const writer = createVaultWriter(config);
const noteSync = writer
  ? createNoteSync({ store, writer, prefix: config.VAULT_HEALTH_PREFIX })
  : null;
const app = createApp({ config, store, noteSync });

const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`listening on :${info.port}`);
});

function shutdown(signal: string) {
  console.log(`${signal} received, shutting down`);
  server.close((err) => {
    void (writer?.close() ?? Promise.resolve()).finally(() => process.exit(err ? 1 : 0));
  });
  // keep-alive 接続で閉じきれない場合の保険
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
