import type { HealthStore } from "../store/health-store.js";
import type { VaultWriter } from "../vault/vault-writer.js";
import { noteRootFromPrefix, writeMany } from "../vault/vault-writer.js";
import { type PlanItem, planNotes } from "./plan.js";

export interface SyncReport {
  written: string[];
  unchanged: string[];
  failed: { path: string; error: string }[];
}

export interface NoteSyncDeps {
  store: HealthStore;
  writer: VaultWriter;
  root?: string;
  concurrency?: number;
}

const minDate = (a: string, b: string) => (a < b ? a : b);
const maxDate = (a: string, b: string) => (a > b ? a : b);

export class NoteSync {
  private readonly store: HealthStore;
  private readonly writer: VaultWriter;
  private readonly root?: string;
  private readonly concurrency: number;

  constructor(deps: NoteSyncDeps) {
    this.store = deps.store;
    this.writer = deps.writer;
    this.root = deps.root;
    this.concurrency = Math.max(1, deps.concurrency ?? 3);
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
    const prev = await this.store.findAdjacentDate(from, "prev");
    const next = await this.store.findAdjacentDate(to, "next");
    const prevPrev = prev ? await this.store.findAdjacentDate(prev, "prev") : null;
    const nextNext = next ? await this.store.findAdjacentDate(next, "next") : null;

    // 影響を受ける日は [prev, next] に収まる。月次集計のため、その月は全日読む
    const inner = { start: prev ?? from, end: next ?? to };
    const start = minDate(prevPrev ?? inner.start, `${inner.start.slice(0, 7)}-01`);
    const end = maxDate(nextNext ?? inner.end, `${inner.end.slice(0, 7)}-31`);
    const days = await this.store.getDays(start, end);

    const targetDates =
      targets ?? days.filter((d) => d.date >= from && d.date <= to).map((d) => d.date);
    const items = planNotes(days, targetDates, this.root, { includeStatic });
    return this.apply(items);
  }

  private async apply(items: PlanItem[]): Promise<SyncReport> {
    const report: SyncReport = { written: [], unchanged: [], failed: [] };
    const toWrite: { path: string; content: string }[] = [];

    await mapLimit(items, this.concurrency, async (item) => {
      try {
        const existing = await this.writer.readNote(item.path);
        const content = item.render(existing);
        if (existing === content) report.unchanged.push(item.path);
        else toWrite.push({ path: item.path, content });
      } catch (e) {
        report.failed.push({
          path: item.path,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    });

    const res = await writeMany(this.writer, toWrite, {
      concurrency: this.concurrency,
    });
    const failedPaths = new Set(res.failed.map((f) => f.path));
    report.written = toWrite.map((w) => w.path).filter((p) => !failedPaths.has(p));
    report.failed.push(...res.failed);
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
  let next = 0;
  async function worker() {
    while (next < items.length) await fn(items[next++]!);
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// 書き込みを許可したフォルダ（VAULT_HEALTH_PREFIX）の下にノートを生成する NoteSync を作る。
// 検証と生成で別のフォルダを使うと、すべての書き込みが拒否される
export function createNoteSync(deps: {
  store: HealthStore;
  writer: VaultWriter;
  prefix: string;
}): NoteSync {
  return new NoteSync({
    store: deps.store,
    writer: deps.writer,
    root: noteRootFromPrefix(deps.prefix),
  });
}
