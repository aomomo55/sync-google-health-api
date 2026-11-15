import { type DailySummary, isSameDay, mergeDay } from "../domain/daily.js";
import {
  fromJstSlot,
  groupByJstDate,
  mergeSlots,
  type RoomReading,
  type RoomSlot,
} from "../domain/room.js";
import type { HealthStore } from "./health-store.js";
import type { RoomStore } from "./room-store.js";

export class MemoryStore implements HealthStore, RoomStore {
  private readonly days = new Map<string, DailySummary>();
  private readonly room = new Map<string, RoomSlot[]>();

  async upsertReadings(readings: RoomReading[]): Promise<{ written: number; unchanged: number }> {
    const results = [...groupByJstDate(readings)].map(([date, incoming]) => {
      const { slots, changed } = mergeSlots(this.room.get(date) ?? [], incoming);
      this.room.set(date, slots);
      return { written: changed, unchanged: incoming.length - changed };
    });
    return results.reduce(
      (acc, r) => ({ written: acc.written + r.written, unchanged: acc.unchanged + r.unchanged }),
      { written: 0, unchanged: 0 },
    );
  }

  async getReadings(from: string, to: string): Promise<RoomReading[]> {
    return [...this.room.entries()]
      .filter(([date]) => date >= from && date <= to)
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([date, slots]) => slots.map((s) => fromJstSlot(date, s)));
  }

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
