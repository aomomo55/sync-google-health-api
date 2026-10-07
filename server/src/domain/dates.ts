export const MS_PER_MINUTE = 60_000;
export const MINUTES_PER_DAY = 1440;
export const MS_PER_DAY = MINUTES_PER_DAY * MS_PER_MINUTE;
// 日付はすべて Asia/Tokyo の暦日。日本は夏時間が無いので、オフセットは常に +09:00
export const JST_OFFSET_MS = 9 * 60 * MS_PER_MINUTE;
export const JST_OFFSET = "+09:00";

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_RE = /^(\d{4})-(\d{2})$/;

export function isRealDate(s: string): boolean {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

export function isRealMonth(s: string): boolean {
  const m = MONTH_RE.exec(s);
  if (!m) return false;
  const mo = Number(m[2]);
  return mo >= 1 && mo <= 12;
}

// from..to を両端含む日数で返す（両方とも妥当な日付であること）
export function inclusiveDays(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / MS_PER_DAY) + 1;
}

export function inclusiveMonths(from: string, to: string): number {
  const f = MONTH_RE.exec(from);
  const t = MONTH_RE.exec(to);
  if (!f || !t) return 0;
  return (Number(t[1]) - Number(f[1])) * 12 + (Number(t[2]) - Number(f[2])) + 1;
}

// YYYY-MM-DD に日数を足す（負も可）
export function addDays(date: string, n: number): string {
  return new Date(Date.parse(date) + n * MS_PER_DAY).toISOString().slice(0, 10);
}

// YYYY-MM の月の全日を、文書のキーや日付の文字列比較で取り出すための範囲。
// 文字列で比べるので、月末は実在するかに関係なく -31 で足りる
export function monthKeyRange(month: string): { start: string; end: string } {
  return { start: `${month}-01`, end: `${month}-31` };
}

// 任意のオフセット付き ISO 文字列を、Asia/Tokyo の 0:00 からの経過分（秒は切り捨て）に変換。不正なら null
export function jstMinutesOfDay(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const d = new Date(t + JST_OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

// 0:00 からの経過分を "HH:MM" にする。分に四捨五入し、24 時間で巻き戻す
export function formatHm(minutes: number): string {
  const m = ((Math.round(minutes) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}
