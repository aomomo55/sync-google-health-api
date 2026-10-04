import { type DailySummary, mergeDay } from "../domain/daily.js";
import type { HealthStore } from "./health-store.js";

export class MemoryStore implements HealthStore {
  private readonly days = new Map<string, DailySummary>();

  async ensureReady(): Promise<void> {}

  async upsertDays(days: DailySummary[]): Promise<{ written: number }> {
    for (const d of days) {
      this.days.set(d.date, mergeDay(this.days.get(d.date), d));
    }
    return { written: days.length };
  }

  async getDays(from: string, to: string): Promise<DailySummary[]> {
    return [...this.days.values()]
      .filter((d) => d.date >= from && d.date <= to)
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
