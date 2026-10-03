const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_RE = /^(\d{4})-(\d{2})$/;

export function isRealDate(s: string): boolean {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return (
    t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d
  );
}

export function isRealMonth(s: string): boolean {
  const m = MONTH_RE.exec(s);
  if (!m) return false;
  const mo = Number(m[2]);
  return mo >= 1 && mo <= 12;
}

// from..to を両端含む日数で返す（両方とも妥当な日付であること）
export function inclusiveDays(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
}

export function inclusiveMonths(from: string, to: string): number {
  const f = MONTH_RE.exec(from);
  const t = MONTH_RE.exec(to);
  if (!f || !t) return 0;
  return (
    (Number(t[1]) - Number(f[1])) * 12 + (Number(t[2]) - Number(f[2])) + 1
  );
}

// YYYY-MM-DD に日数を足す（負も可）
export function addDays(date: string, n: number): string {
  return new Date(Date.parse(date) + n * 86_400_000).toISOString().slice(0, 10);
}
