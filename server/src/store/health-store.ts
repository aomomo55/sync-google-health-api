import type { DailySummary } from "../domain/daily.js";

export interface HealthStore {
  upsertDays(days: DailySummary[]): Promise<{ written: number }>;
  // from/to を両端含む。日付昇順
  getDays(from: string, to: string): Promise<DailySummary[]>;
  // date より前（prev）/後（next）でデータのある最も近い日。date 自身は含まない
  findAdjacentDate(date: string, direction: "prev" | "next"): Promise<string | null>;
  ensureReady(): Promise<void>;
}
