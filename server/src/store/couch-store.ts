import { type DailySummary, mergeDay } from "../domain/daily.js";
import type { HealthStore } from "./health-store.js";

export interface CouchStoreOptions {
  baseUrl: string;
  user: string;
  password: string;
  db: string;
  fetch?: typeof fetch;
}

type CouchDoc = DailySummary & {
  _id: string;
  _rev?: string;
  type: "daily";
  updated_at: string;
};

type AllDocsRow = { doc?: CouchDoc | null; value?: { deleted?: boolean } };
type BulkResult = { id?: string; ok?: boolean; error?: string };

const MAX_CONFLICT_RETRIES = 3;

export class CouchStore implements HealthStore {
  private readonly base: string;
  private readonly auth: string;
  private readonly db: string;
  private readonly fetchFn: typeof fetch;

  constructor(opts: CouchStoreOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, "");
    this.auth = `Basic ${Buffer.from(`${opts.user}:${opts.password}`).toString("base64")}`;
    this.db = encodeURIComponent(opts.db);
    this.fetchFn = opts.fetch ?? fetch;
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    okStatuses: number[] = [200, 201, 202],
  ): Promise<unknown> {
    const res = await this.fetchFn(`${this.base}/${this.db}${path}`, {
      method,
      headers: {
        Authorization: this.auth,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!okStatuses.includes(res.status)) {
      // 認証情報やレスポンス本文は含めない
      throw new Error(`CouchDB ${method} ${path.split("?")[0] || "/"} が失敗: HTTP ${res.status}`);
    }
    return res.json().catch(() => null);
  }

  async ensureReady(): Promise<void> {
    await this.request("PUT", "", undefined, [201, 202, 412]);
  }

  private static toDay(doc: CouchDoc): DailySummary {
    const { _id, _rev, type, updated_at, ...day } = doc;
    void [_id, _rev, type, updated_at];
    return day as DailySummary;
  }

  private static docsOf(json: unknown): CouchDoc[] {
    const rows = (json as { rows?: AllDocsRow[] } | null)?.rows ?? [];
    return rows.flatMap((r) => (r.doc && !r.value?.deleted ? [r.doc] : []));
  }

  async getDays(from: string, to: string): Promise<DailySummary[]> {
    const key = (s: string) => encodeURIComponent(JSON.stringify(s));
    const json = await this.request(
      "GET",
      `/_all_docs?include_docs=true&startkey=${key(`day:${from}`)}&endkey=${key(`day:${to}`)}`,
    );
    return CouchStore.docsOf(json)
      .map((d) => CouchStore.toDay(d))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  async findAdjacentDate(date: string, direction: "prev" | "next"): Promise<string | null> {
    // キー順で前後を 2 件取り、date 自身を除いた最初の日を返す
    const key = (s: string) => encodeURIComponent(JSON.stringify(s));
    const query =
      direction === "prev"
        ? `descending=true&startkey=${key(`day:${date}`)}&endkey=${key("day:")}`
        : `startkey=${key(`day:${date}`)}&endkey=${key("day:￰")}`;
    const json = await this.request("GET", `/_all_docs?${query}&limit=2`);
    const rows = (json as { rows?: { id: string }[] } | null)?.rows ?? [];
    const hit = rows.find((r) => r.id !== `day:${date}`);
    return hit ? hit.id.slice("day:".length) : null;
  }

  async upsertDays(days: DailySummary[]): Promise<{ written: number }> {
    // 同一日付が複数あれば先にマージしておく
    const merged = new Map<string, DailySummary>();
    for (const d of days) merged.set(d.date, mergeDay(merged.get(d.date), d));
    let pending = [...merged.values()];
    let written = 0;

    for (let attempt = 0; pending.length > 0; attempt++) {
      if (attempt > MAX_CONFLICT_RETRIES) {
        throw new Error("CouchDB への書き込みが競合し続けました");
      }
      const existingJson = await this.request("POST", "/_all_docs?include_docs=true", {
        keys: pending.map((d) => `day:${d.date}`),
      });
      const existing = new Map(CouchStore.docsOf(existingJson).map((d) => [d._id, d]));
      const now = new Date().toISOString();
      const docs = pending.map((incoming) => {
        const id = `day:${incoming.date}`;
        const old = existing.get(id);
        const m = mergeDay(old ? CouchStore.toDay(old) : undefined, incoming);
        const doc: CouchDoc = { ...m, _id: id, type: "daily", updated_at: now };
        if (old?._rev) doc._rev = old._rev;
        return doc;
      });

      const json = await this.request("POST", "/_bulk_docs", { docs });
      const results = Array.isArray(json) ? (json as BulkResult[]) : [];
      const conflicts = new Set<string>();
      for (const r of results) {
        if (r.ok) written++;
        else if (r.error === "conflict" && r.id) conflicts.add(r.id);
        else
          throw new Error(`CouchDB bulk 書き込みエラー: ${r.error ?? "unknown"} (${r.id ?? "?"})`);
      }
      pending = pending.filter((d) => conflicts.has(`day:${d.date}`));
    }
    return { written };
  }
}
