import type { DailySummary } from "../domain/daily.js";

export type Segment = {
  source: string;
  start: number; // epoch ms
  end: number;
  stage: number;
};

export type Session = {
  source: string;
  segments: Segment[];
  start: number;
  end: number;
};

type SleepFields = NonNullable<DailySummary["sleep"]>;

export type ChosenSleep = {
  source: string;
  sleep: SleepFields;
  hasStages: boolean;
};

export const SESSION_GAP_MS = 60 * 60_000;
const JST_OFFSET_MS = 9 * 3_600_000;
const MIN = 60_000;

// raw_com.google.sleep.segment_<source>.json → <source>
export function sourceFromFilename(name: string): string | undefined {
  const m = /^raw_com\.google\.sleep\.segment_(.+)\.json$/.exec(name);
  return m?.[1];
}

export function jstDate(ms: number): string {
  return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 10);
}

export function jstIso(ms: number): string {
  const sec = Math.round(ms / 1000) * 1000; // .999 秒の端数を丸める
  return `${new Date(sec + JST_OFFSET_MS).toISOString().slice(0, 19)}+09:00`;
}

// Takeout の raw sleep segment JSON を Segment[] にする
export function parseSleepJson(json: unknown, source: string): Segment[] {
  const points = (json as { "Data Points"?: unknown } | null)?.["Data Points"];
  if (!Array.isArray(points)) return [];
  const out: Segment[] = [];
  for (const p of points as Record<string, unknown>[]) {
    const s = Number(p.startTimeNanos) / 1e6;
    const e = Number(p.endTimeNanos) / 1e6;
    const fv = p.fitValue as { value?: { intVal?: unknown } }[] | undefined;
    const stage = Number(fv?.[0]?.value?.intVal ?? 0);
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue;
    out.push({ source, start: Math.round(s), end: Math.round(e), stage });
  }
  return out;
}

// 1 ソース分の segment を、gap <= 60 分で連続するものを 1 セッションにまとめる
export function sessionize(segments: Segment[], gapMs = SESSION_GAP_MS): Session[] {
  const sorted = [...segments].sort((a, b) => a.start - b.start || a.end - b.end);
  const sessions: Session[] = [];
  let cur: Session | undefined;
  for (const seg of sorted) {
    if (cur && seg.start - cur.end <= gapMs) {
      cur.segments.push(seg);
      cur.end = Math.max(cur.end, seg.end);
    } else {
      cur = {
        source: seg.source,
        segments: [seg],
        start: seg.start,
        end: seg.end,
      };
      sessions.push(cur);
    }
  }
  return sessions;
}

const isAwake = (stage: number) => stage === 1 || stage === 3;

function stageMs(s: Session, pred: (stage: number) => boolean): number {
  let t = 0;
  for (const g of s.segments) if (pred(g.stage)) t += g.end - g.start;
  return t;
}

const asleepMs = (s: Session) => s.end - s.start - stageMs(s, isAwake);

export function summarizeSession(s: Session): {
  sleep: SleepFields;
  hasStages: boolean;
} {
  const inBed = s.end - s.start;
  const awake = stageMs(s, isAwake);
  const hasStages = s.segments.some((g) => g.stage >= 4 && g.stage <= 6);
  const sleep: SleepFields = {
    start: jstIso(s.start),
    end: jstIso(s.end),
    in_bed_minutes: Math.round(inBed / MIN),
    awake_minutes: Math.round(awake / MIN),
    asleep_minutes: Math.round((inBed - awake) / MIN),
  };
  if (hasStages) {
    sleep.deep_minutes = Math.round(stageMs(s, (x) => x === 5) / MIN);
    sleep.light_minutes = Math.round(stageMs(s, (x) => x === 4) / MIN);
    sleep.rem_minutes = Math.round(stageMs(s, (x) => x === 6) / MIN);
  }
  return { sleep, hasStages };
}

const hasStagedSleep = (sessions: Session[]) =>
  sessions.some((s) => s.segments.some((g) => g.stage >= 4 && g.stage <= 6));

const totalMs = (sessions: Session[]) => sessions.reduce((t, s) => t + (s.end - s.start), 0);

// ステージ付きを優先し、次に合計時間が長いもの。同点は source id の辞書順
function pickSource(sources: Map<string, Session[]>): [string, Session[]] {
  return [...sources.entries()].sort(
    (a, b) =>
      Number(hasStagedSleep(b[1])) - Number(hasStagedSleep(a[1])) ||
      totalMs(b[1]) - totalMs(a[1]) ||
      (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
  )[0]!;
}

// 全ソースの segment から、起床日(JST)ごとに採用する睡眠を決める
export function buildSleepByDate(segments: Segment[]): Map<string, ChosenSleep> {
  const bySource = new Map<string, Segment[]>();
  for (const seg of segments) {
    const list = bySource.get(seg.source);
    if (list) list.push(seg);
    else bySource.set(seg.source, [seg]);
  }

  // date -> source -> sessions
  const byDate = new Map<string, Map<string, Session[]>>();
  for (const [source, segs] of bySource) {
    for (const session of sessionize(segs)) {
      const date = jstDate(session.end);
      let m = byDate.get(date);
      if (!m) {
        m = new Map();
        byDate.set(date, m);
      }
      const list = m.get(source);
      if (list) list.push(session);
      else m.set(source, [session]);
    }
  }

  const result = new Map<string, ChosenSleep>();
  for (const [date, sources] of byDate) {
    const [source, sessions] = pickSource(sources);
    // 最長を main に（同長なら先に起きた方）
    const main = sessions.reduce((best, s) => (s.end - s.start > best.end - best.start ? s : best));
    const { sleep, hasStages } = summarizeSession(main);
    const naps = sessions.filter((s) => s !== main);
    if (naps.length > 0) {
      sleep.nap_minutes = Math.round(naps.reduce((t, s) => t + asleepMs(s), 0) / MIN);
    }
    result.set(date, { source, sleep, hasStages });
  }
  return result;
}
