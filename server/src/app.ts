import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { HTTPException } from "hono/http-exception";
import type { Config } from "./config.js";
import { healthRoutes } from "./routes/health.js";
import type { HealthStore } from "./store/health-store.js";
import type { NoteSync } from "./sync/note-sync.js";

export interface AppDeps {
  config: Pick<Config, "API_TOKEN">;
  store: HealthStore;
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
