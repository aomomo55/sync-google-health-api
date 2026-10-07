import { type DailySummary, mergeDay } from "../domain/daily.js";
import type { HealthStore } from "./health-store.js";

export interface CouchStoreOptions {
  baseUrl: string;
  user: string;
  password: string;
  db: string;
  // 1 リクエストあたりの上限（ms）。応答の無い CouchDB で処理が止まり続けないようにする
  timeoutMs?: number;
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
// 日次の文書の _id は "day:YYYY-MM-DD"。DAY_ID_END は全ての日の _id より後ろに並ぶキー
const DAY_ID_PREFIX = "day:";
const DAY_ID_END = `${DAY_ID_PREFIX}\uffff`;
const dayId = (date: string) => `${DAY_ID_PREFIX}${date}`;
const queryKey = (s: string) => encodeURIComponent(JSON.stringify(s));
const DEFAULT_TIMEOUT_MS = 10_000;

const isTimeout = (e: unknown) =>
  e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");

export class CouchStore implements HealthStore {
  private readonly base: string;
  private readonly auth: string;
  private readonly db: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: CouchStoreOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, "");
    this.auth = `Basic ${Buffer.from(`${opts.user}:${opts.password}`).toString("base64")}`;
    this.db = encodeURIComponent(opts.db);
    this.fetchFn = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    okStatuses: number[] = [200, 201, 202],
  ): Promise<unknown> {
    // 認証情報やクエリ、レスポンス本文はエラー文に含めない
    const label = `CouchDB ${method} ${path.split("?")[0] || "/"}`;
    const timeoutError = () => new Error(`${label} がタイムアウトしました（${this.timeoutMs} ms）`);
    const res = await this.fetchFn(`${this.base}/${this.db}${path}`, {
      method,
      headers: {
        Authorization: this.auth,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    }).catch((e: unknown) => {
      if (isTimeout(e)) throw timeoutError();
      throw new Error(`${label} に接続できません`, { cause: e });
    });
    if (!okStatuses.includes(res.status)) {
      throw new Error(`${label} が失敗: HTTP ${res.status}`);
    }
    return res.json().catch((e: unknown) => {
      if (isTimeout(e)) throw timeoutError();
      return null;
    });
  }

  // DB の作成には CouchDB 管理者の権限が要る。DB 専用ユーザーで動かせるよう、存在すれば作成しない
  async ensureReady(): Promise<void> {
    const exists = await this.request("GET", "", undefined, [200, 404]).then(
      (json) => !(json as { error?: string } | null)?.error,
    );
    if (exists) return;
    try {
      await this.request("PUT", "", undefined, [201, 202, 412]);
    } catch (e) {
      throw new Error(
        `CouchDB に DB "${decodeURIComponent(this.db)}" が無く、作成する権限もありません。管理者で作成してください（${e instanceof Error ? e.message : String(e)}）`,
      );
    }
  }

  // DB にある文書の数（day: 以外や _design 文書も含む）
  async countDocs(): Promise<number> {
    const json = (await this.request("GET", "")) as { doc_count?: unknown } | null;
    if (typeof json?.doc_count !== "number") {
      throw new Error("CouchDB GET / の応答に doc_count がありません");
    }
    return json.doc_count;
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
    return this.getDaysByKey(dayId(from), dayId(to));
  }

  async getAllDays(): Promise<DailySummary[]> {
    return this.getDaysByKey(DAY_ID_PREFIX, DAY_ID_END);
  }

  private async getDaysByKey(startkey: string, endkey: string): Promise<DailySummary[]> {
    const json = await this.request(
      "GET",
      `/_all_docs?include_docs=true&startkey=${queryKey(startkey)}&endkey=${queryKey(endkey)}`,
    );
    return CouchStore.docsOf(json)
      .map((d) => ({ id: String(d._id), doc: d }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map(({ id, doc }) => CouchStore.dayFromDoc(id, doc));
  }

  // 日付の正は文書の _id（day:YYYY-MM-DD）とする。範囲の取得も findAdjacentDate も _id のキー順で引くため。
  // 本文の date が無い・文字列でない・_id と食い違う文書は、date に _id を入れて返す。
  // 実在する日付にならないので、同期処理（splitValidDays）が不正な日として失敗に載せ、該当する文書も示せる
  private static dayFromDoc(id: string, doc: CouchDoc): DailySummary {
    const day = CouchStore.toDay(doc);
    const date: unknown = doc.date;
    if (typeof date === "string" && dayId(date) === id) return day;
    return { ...day, date: id };
  }

  async findAdjacentDate(date: string, direction: "prev" | "next"): Promise<string | null> {
    // キー順で前後を 2 件取り、date 自身を除いた最初の日を返す（日付の正は _id。getDays と同じ）
    const query =
      direction === "prev"
        ? `descending=true&startkey=${queryKey(dayId(date))}&endkey=${queryKey(DAY_ID_PREFIX)}`
        : `startkey=${queryKey(dayId(date))}&endkey=${queryKey(DAY_ID_END)}`;
    const json = await this.request("GET", `/_all_docs?${query}&limit=2`);
    const rows = (json as { rows?: { id: string }[] } | null)?.rows ?? [];
    const hit = rows.find((r) => r.id !== dayId(date));
    return hit ? hit.id.slice(DAY_ID_PREFIX.length) : null;
  }

  async upsertDays(days: DailySummary[]): Promise<{ written: number }> {
    // 同一日付が複数あれば先にマージしておく
    const merged = new Map<string, DailySummary>();
    for (const d of days) merged.set(d.date, mergeDay(merged.get(d.date), d));
    // 競合した分だけを再送するリトライの制御なので let にする
    let pending = [...merged.values()];
    let written = 0;

    for (let attempt = 0; pending.length > 0; attempt++) {
      if (attempt > MAX_CONFLICT_RETRIES) {
        throw new Error("CouchDB への書き込みが競合し続けました");
      }
      const existingJson = await this.request("POST", "/_all_docs?include_docs=true", {
        keys: pending.map((d) => dayId(d.date)),
      });
      const existing = new Map(CouchStore.docsOf(existingJson).map((d) => [d._id, d]));
      const now = new Date().toISOString();
      const docs = pending.map((incoming) => {
        const id = dayId(incoming.date);
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
      pending = pending.filter((d) => conflicts.has(dayId(d.date)));
    }
    return { written };
  }
}
