import { type DailySummary, isSameDay, mergeDay } from "../domain/daily.js";
import type { HealthStore } from "./health-store.js";

export class MemoryStore implements HealthStore {
  private readonly days = new Map<string, DailySummary>();

  async ensureReady(): Promise<void> {}

  async upsertDays(days: DailySummary[]): Promise<{ written: number; unchanged: number }> {
    // 同一日付が複数あれば先にマージしておく（CouchStore と同じ）
    const merged = days.reduce(
      (acc, d) => acc.set(d.date, mergeDay(acc.get(d.date), d)),
      new Map<string, DailySummary>(),
    );
    const changed = [...merged.values()]
      .map((incoming) => {
        const old = this.days.get(incoming.date);
        const m = mergeDay(old, incoming);
        return old && isSameDay(old, m) ? null : m;
      })
      .filter((d): d is DailySummary => d !== null);
    for (const d of changed) this.days.set(d.date, d);
    return { written: changed.length, unchanged: merged.size - changed.length };
  }

  async getDays(from: string, to: string): Promise<DailySummary[]> {
    return [...this.days.values()]
      .filter((d) => d.date >= from && d.date <= to)
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((d) => structuredClone(d));
  }

  async getAllDays(): Promise<DailySummary[]> {
    return [...this.days.values()]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((d) => structuredClone(d));
  }

  async findAdjacentDate(date: string, direction: "prev" | "next"): Promise<string | null> {
    const dates = [...this.days.keys()].sort();
    const found =
      direction === "prev" ? dates.filter((d) => d < date).at(-1) : dates.find((d) => d > date);
    return found ?? null;
  }
}
