import type { DailySummary } from "../domain/daily.js";
import { addDays, isRealDate, monthKeyRange } from "../domain/dates.js";
import { type NightClimate, summarizeNights } from "../domain/room.js";
import { MemoMarkerMissingError } from "../notes/index.js";
import type { HealthStore } from "../store/health-store.js";
import type { RoomStore } from "../store/room-store.js";
import type { VaultPathError, VaultWriter } from "../vault/vault-writer.js";
import { affectedNotes, type PlanItem, planNotes, splitValidDays } from "./plan.js";

const INVALID_DATE_MESSAGE =
  "保存されている日付が不正なため、ノートを生成しませんでした。CouchDB の該当する文書を確認してください";
const MAX_INVALID_SKIP = 20;
// Vault への読み書きを同時に行う数
const DEFAULT_CONCURRENCY = 3;

export const NOTE_FAILURE_MESSAGE =
  "Vault への書き込みに失敗しました。健康データは保存済みで、次の送信で送った日のノートは作り直されます。続くときは、obsidian-sync-mcp が動いているかとサーバーのログを確かめてください";

// VaultWriter が、書き込み先のパスが許可範囲の外のときに投げるエラーの名前。
// 型で VaultPathError の name と結び付け、綴りが食い違えば型検査で気付けるようにする
const VAULT_PATH_ERROR_NAME: VaultPathError["name"] = "VaultPathError";

const isVaultPathError = (e: unknown): e is VaultPathError =>
  e instanceof Error && e.name === VAULT_PATH_ERROR_NAME;

// 応答に載せるエラー文。利用者が対処できる既知のエラーだけ文面を返し、
// それ以外（内部の通信エラーなど）は固定の文にする
export function publicErrorMessage(e: unknown): string {
  if (e instanceof MemoMarkerMissingError || isVaultPathError(e)) return e.message;
  return NOTE_FAILURE_MESSAGE;
}

// ログ用の要約。cause をたどるとトークンを含む値が出るおそれがあるので、名前と文面だけにする
export function describeForLog(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

export interface SyncReport {
  written: string[];
  unchanged: string[];
  failed: { path: string; error: string }[];
}

export interface NoteSyncDeps {
  store: HealthStore;
  // 寝室の温湿度。無ければ日次ノートの温湿度は空になる
  room?: RoomStore | null;
  writer: VaultWriter;
  root?: string;
  concurrency?: number;
}

const minDate = (a: string, b: string) => (a < b ? a : b);
const maxDate = (a: string, b: string) => (a > b ? a : b);

export class NoteSync {
  private readonly store: HealthStore;
  private readonly room: RoomStore | null;
  private readonly writer: VaultWriter;
  private readonly root?: string;
  private readonly concurrency: number;

  constructor(deps: NoteSyncDeps) {
    this.store = deps.store;
    this.room = deps.room ?? null;
    this.writer = deps.writer;
    this.root = deps.root;
    this.concurrency = Math.max(1, deps.concurrency ?? DEFAULT_CONCURRENCY);
  }

  async syncDates(dates: string[]): Promise<SyncReport> {
    if (dates.length === 0) return { written: [], unchanged: [], failed: [] };
    const sorted = [...dates].sort();
    return this.run(sorted[0]!, sorted.at(-1)!, dates, false);
  }

  async syncRange(
    from: string,
    to: string,
    opts: { includeStatic?: boolean } = {},
  ): Promise<SyncReport> {
    return this.run(from, to, null, opts.includeStatic ?? false);
  }

  // targets が null なら [from, to] 内でデータのある全日が対象
  private async run(
    from: string,
    to: string,
    targets: string[] | null,
    includeStatic: boolean,
  ): Promise<SyncReport> {
    // 範囲の外で最も近い日（前後リンクが変わる）と、その更に外側の日（その日自身のリンク用）。
    // データが何か月途切れていても正しくつながるよう、窓ではなく直接問い合わせる
    const prev = await this.adjacent(from, "prev");
    const next = await this.adjacent(to, "next");
    const prevPrev = prev ? await this.adjacent(prev, "prev") : null;
    const nextNext = next ? await this.adjacent(next, "next") : null;

    // 影響を受ける日は [prev, next] に収まる。月次集計のため、その月は全日読む
    const inner = { start: prev ?? from, end: next ?? to };
    const start = minDate(prevPrev ?? inner.start, monthKeyRange(inner.start.slice(0, 7)).start);
    const monthEnd = maxDate(nextNext ?? inner.end, monthKeyRange(inner.end.slice(0, 7)).end);
    // 最後の月の末日が「まだ届いていない」かの判定に、その後で最も早いデータのある日も読む
    // （対象の日にも前後リンクにも入らない）
    const end = (await this.adjacent(monthEnd, "next")) ?? monthEnd;
    // DB の日付は書き込み時に検証済みのはずだが、手で直された文書などに備えて再検証する。
    // 不正な日付はパスや YAML にそのまま入るので、ノートを作らず失敗として報告する
    const { valid: days, invalid } = splitValidDays(await this.store.getDays(start, end));
    const failed = invalid.map((d) => {
      const label = `日付 ${JSON.stringify(d.date)}`;
      console.error(`保存されている日付が不正なため、ノートを生成しません: ${label}`);
      return { path: label, error: INVALID_DATE_MESSAGE };
    });

    const targetDates =
      targets ?? days.filter((d) => d.date >= from && d.date <= to).map((d) => d.date);
    const climate = await this.nightClimate(days, targetDates);
    const items = planNotes(days, targetDates, this.root, { includeStatic, climate });
    return this.apply(items, failed);
  }

  // 日次ノートを作り直す日（対象の日と前後の日。planNotes と同じ affectedNotes で決める）の夜の温湿度。
  // 就寝は起床日の前日に始まるので、前日から読む。
  // 温湿度は補助の計測なので、読めなくても空にしてノートの同期は続ける（ADR 0033）
  private async nightClimate(
    days: DailySummary[],
    targetDates: string[],
  ): Promise<Map<string, NightClimate>> {
    if (!this.room) return new Map();
    const dates = new Set(affectedNotes(days, targetDates).dates);
    const nightDays = days.filter((d) => dates.has(d.date));
    const first = nightDays[0]?.date;
    const last = nightDays.at(-1)?.date;
    if (!first || !last) return new Map();
    try {
      const readings = await this.room.getReadings(addDays(first, -1), last);
      const nights = nightDays.map((d) => ({
        date: d.date,
        start: d.sleep?.start,
        end: d.sleep?.end,
      }));
      return summarizeNights(nights, readings);
    } catch (e) {
      console.error(
        `寝室の温湿度を読めなかったので、温湿度を空にしてノートを同期します: ${describeForLog(e)}`,
      );
      return new Map();
    }
  }

  // 前後の日を、不正な日付を読み飛ばして求める
  private async adjacent(date: string, direction: "prev" | "next"): Promise<string | null> {
    // 辿った先を次の起点にするループの制御なので let にする
    let cur = date;
    for (let i = 0; i < MAX_INVALID_SKIP; i++) {
      const found = await this.store.findAdjacentDate(cur, direction);
      if (found === null || isRealDate(found)) return found;
      cur = found;
    }
    return null;
  }

  private async apply(
    items: PlanItem[],
    preFailed: SyncReport["failed"] = [],
  ): Promise<SyncReport> {
    const report: SyncReport = { written: [], unchanged: [], failed: [...preFailed] };
    const toWrite: { path: string; content: string }[] = [];
    const fail = (path: string, e: unknown) => {
      console.error(`ノートの同期に失敗: ${path}: ${describeForLog(e)}`);
      report.failed.push({ path, error: publicErrorMessage(e) });
    };

    await mapLimit(items, this.concurrency, async (item) => {
      try {
        const existing = await this.writer.readNote(item.path);
        const content = item.render(existing);
        if (existing === content) report.unchanged.push(item.path);
        else toWrite.push({ path: item.path, content });
      } catch (e) {
        fail(item.path, e);
      }
    });

    // 個々の失敗では止めない
    await mapLimit(toWrite, this.concurrency, async (w) => {
      try {
        await this.writer.writeNote(w.path, w.content);
        report.written.push(w.path);
      } catch (e) {
        fail(w.path, e);
      }
    });
    report.written.sort();
    report.unchanged.sort();
    return report;
  }
}

async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  // 複数の worker が共有する取り出し位置なので let にする
  let next = 0;
  async function worker() {
    while (next < items.length) await fn(items[next++]!);
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
