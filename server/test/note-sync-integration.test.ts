import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CouchStore } from "../src/store/couch-store.js";
import { NoteSync } from "../src/sync/note-sync.js";
import { McpVaultWriter } from "../src/vault/mcp-vault-writer.js";

const MCP_URL = process.env.OBSIDIAN_MCP_TEST_URL;
const MCP_TOKEN = process.env.OBSIDIAN_MCP_TEST_TOKEN;
const COUCH = process.env.COUCHDB_TEST_URL;

describe.skipIf(!MCP_URL || !MCP_TOKEN || !COUCH)(
  "NoteSync 統合（実 CouchDB + 実 obsidian-sync-mcp）",
  () => {
    const dbName = `health_notesync_${Date.now()}`;
    const root = "Health/_it";
    let base = "";
    let auth = "";
    let store: CouchStore;
    let writer: McpVaultWriter;

    beforeAll(async () => {
      const u = new URL(COUCH as string);
      const user = decodeURIComponent(u.username);
      const password = decodeURIComponent(u.password);
      u.username = "";
      u.password = "";
      base = u.toString().replace(/\/+$/, "");
      auth = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
      store = new CouchStore({ baseUrl: base, user, password, db: dbName });
      await store.ensureReady();
      writer = new McpVaultWriter({ url: MCP_URL as string, token: MCP_TOKEN as string });
    });

    afterAll(async () => {
      await writer?.close();
      if (base) {
        await fetch(`${base}/${dbName}`, { method: "DELETE", headers: { Authorization: auth } });
      }
    });

    it("3日分を ingest して Vault から読み戻せ、再同期は変更なし", async () => {
      const sync = new NoteSync({ store, writer, root });
      const dates = ["2026-04-01", "2026-04-02", "2026-04-03"];
      await store.upsertDays(
        dates.map((date, i) => ({ date, activity: { steps: 1000 * (i + 1) } })),
      );
      const r1 = await sync.syncDates(dates);
      expect(r1.failed).toEqual([]);
      expect(r1.written.length + r1.unchanged.length).toBe(4);

      const day2 = await writer.readNote(`${root}/Daily/2026-04-02.md`);
      expect(day2).toContain("2000");
      expect(day2).toContain("Daily/2026-04-01|前日");
      expect(day2).toContain("Daily/2026-04-03|翌日");
      expect(await writer.readNote(`${root}/Monthly/2026-04.md`)).toContain("2026-04");

      const r2 = await sync.syncDates(dates);
      expect(r2.failed).toEqual([]);
      expect(r2.written).toEqual([]);
      expect(r2.unchanged).toHaveLength(4);
    }, 180_000);
  },
);
