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

// 結合したセッションのまとまり。start / end は最初の開始と最後の終了
export type Night = {
  source: string;
  sessions: Session[];
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
// 間隔がこれ以内のセッションは一晩の睡眠として結合する（Android の SleepAssigner.MERGE_GAP と同じ）
export const NIGHT_MERGE_GAP_MS = 2 * 60 * 60_000;
// Takeout の時刻として受け付ける範囲。範囲外は壊れた記録として捨てる（toISOString の RangeError も防ぐ）
export const MIN_TIME_MS = Date.UTC(2000, 0, 1);
export const MAX_TIME_MS = Date.UTC(2100, 0, 1);

export function isSaneTime(ms: number): boolean {
  return Number.isFinite(ms) && ms >= MIN_TIME_MS && ms < MAX_TIME_MS;
}

// 解析中に捨てた記録の件数（取り込み結果に表示する）
export type ParseStats = { invalidTime: number };
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

// Takeout の raw sleep segment JSON を Segment[] にする。時刻が不正な記録は捨てて stats に数える
export function parseSleepJson(json: unknown, source: string, stats?: ParseStats): Segment[] {
  const points = (json as { "Data Points"?: unknown } | null)?.["Data Points"];
  if (!Array.isArray(points)) return [];
  const out: Segment[] = [];
  for (const p of points as Record<string, unknown>[]) {
    const s = Number(p.startTimeNanos) / 1e6;
    const e = Number(p.endTimeNanos) / 1e6;
    const fv = p.fitValue as { value?: { intVal?: unknown } }[] | undefined;
    const stage = Number(fv?.[0]?.value?.intVal ?? 0);
    if (!isSaneTime(s) || !isSaneTime(e) || e <= s) {
      if (stats) stats.invalidTime++;
      continue;
    }
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

// 開始順のセッションを、前のまとまりの終了から gapMs 以内に始まるものを同じまとまりにする
export function mergeNights(sessions: Session[], gapMs = NIGHT_MERGE_GAP_MS): Night[] {
  const sorted = [...sessions].sort((a, b) => a.start - b.start || a.end - b.end);
  const nights: Night[] = [];
  let cur: Night | undefined;
  for (const s of sorted) {
    if (cur && s.start - cur.end <= gapMs) {
      cur.sessions.push(s);
      cur.end = Math.max(cur.end, s.end);
    } else {
      cur = { source: s.source, sessions: [s], start: s.start, end: s.end };
      nights.push(cur);
    }
  }
  return nights;
}

const isAwake = (stage: number) => stage === 1 || stage === 3;

function stageMs(s: Session, pred: (stage: number) => boolean): number {
  let t = 0;
  for (const g of s.segments) if (pred(g.stage)) t += g.end - g.start;
  return t;
}

const asleepMs = (s: Session) => s.end - s.start - stageMs(s, isAwake);

const nightStageMs = (n: Night, pred: (stage: number) => boolean) =>
  n.sessions.reduce((t, s) => t + stageMs(s, pred), 0);

// まとまりの中で、どの segment にも覆われていない時間の合計
function gapMs(n: Night): number {
  const segs = n.sessions.flatMap((s) => s.segments).sort((a, b) => a.start - b.start);
  let total = 0;
  let end = n.start;
  for (const g of segs) {
    if (g.start > end) total += g.start - end;
    end = Math.max(end, g.end);
  }
  return total;
}

// segment の間の隙間は中途覚醒に数える（Android でセッション間の間隔を数えるのと揃える）
export function summarizeNight(n: Night): {
  sleep: SleepFields;
  hasStages: boolean;
} {
  const inBed = n.end - n.start;
  const awake = nightStageMs(n, isAwake) + gapMs(n);
  const hasStages = n.sessions.some((s) => s.segments.some((g) => g.stage >= 4 && g.stage <= 6));
  const sleep: SleepFields = {
    start: jstIso(n.start),
    end: jstIso(n.end),
    in_bed_minutes: Math.round(inBed / MIN),
    awake_minutes: Math.round(awake / MIN),
    asleep_minutes: Math.round(Math.max(0, inBed - awake) / MIN),
  };
  if (hasStages) {
    sleep.deep_minutes = Math.round(nightStageMs(n, (x) => x === 5) / MIN);
    sleep.light_minutes = Math.round(nightStageMs(n, (x) => x === 4) / MIN);
    sleep.rem_minutes = Math.round(nightStageMs(n, (x) => x === 6) / MIN);
  }
  return { sleep, hasStages };
}

const hasStagedSleep = (nights: Night[]) =>
  nights.some((n) => n.sessions.some((s) => s.segments.some((g) => g.stage >= 4 && g.stage <= 6)));

const totalMs = (nights: Night[]) =>
  nights.reduce((t, n) => t + n.sessions.reduce((u, s) => u + (s.end - s.start), 0), 0);

// ステージ付きを優先し、次に合計時間が長いもの。同点は source id の辞書順
function pickSource(sources: Map<string, Night[]>): [string, Night[]] {
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

  // date -> source -> nights（結合後の終了時刻で起床日を決める）
  const byDate = new Map<string, Map<string, Night[]>>();
  for (const [source, segs] of bySource) {
    for (const night of mergeNights(sessionize(segs))) {
      const date = jstDate(night.end);
      let m = byDate.get(date);
      if (!m) {
        m = new Map();
        byDate.set(date, m);
      }
      const list = m.get(source);
      if (list) list.push(night);
      else m.set(source, [night]);
    }
  }

  const result = new Map<string, ChosenSleep>();
  for (const [date, sources] of byDate) {
    const [source, nights] = pickSource(sources);
    // 最長のまとまりを main に（同長なら先に起きた方）、残りは仮眠
    const main = nights.reduce((best, n) => (n.end - n.start > best.end - best.start ? n : best));
    const { sleep, hasStages } = summarizeNight(main);
    const naps = nights.filter((n) => n !== main).flatMap((n) => n.sessions);
    if (naps.length > 0) {
      sleep.nap_minutes = Math.round(naps.reduce((t, s) => t + asleepMs(s), 0) / MIN);
    }
    result.set(date, { source, sleep, hasStages });
  }
  return result;
}
