import type { RoomReading } from "../domain/room.js";

// 寝室の温湿度の保存先（ADR 0033）。日次データ（HealthStore）とは別の文書に置く
export interface RoomStore {
  // 同じ分（Asia/Tokyo）の値は置き換える。件数は読み取り値の数で、変わらなかったものは unchanged に数える
  upsertReadings(readings: RoomReading[]): Promise<{ written: number; unchanged: number }>;
  // from/to（Asia/Tokyo の YYYY-MM-DD）を両端含む。時刻の昇順
  getReadings(from: string, to: string): Promise<RoomReading[]>;
}
