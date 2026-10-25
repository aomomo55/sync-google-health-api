import { z } from "zod";
import type { DailySummary } from "../domain/daily.js";
import { JST_OFFSET, JST_OFFSET_MS, MS_PER_MINUTE } from "../domain/dates.js";
import { NanosSchema, nanosToMs, type ParseStats, validDataPoints } from "./data-points.js";

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

// Google Fit の睡眠ステージ（segment の intVal）。2 は段階の区別の無い睡眠。
// Health Connect の SleepSessionRecord.STAGE_TYPE_* と同じ値で、Android の SleepAssigner も同じ値を使う
export const SLEEP_STAGE = { awake: 1, outOfBed: 3, light: 4, deep: 5, rem: 6 } as const;

// Takeout の segment を 1 つのセッションにまとめる間隔。Takeout だけの規則
// （Android は Health Connect からセッションの形で受け取るので、この処理が無い）
export const SESSION_GAP_MS = 60 * MS_PER_MINUTE;
// 間隔がこれ以内のセッションは一晩の睡眠として結合する（Android の SleepAssigner.MERGE_GAP と同じ規則。
// 同じ入力のテストを両方に置いている）
export const NIGHT_MERGE_GAP_MS = 2 * 60 * MS_PER_MINUTE;
// Takeout の時刻として受け付ける範囲。範囲外は壊れた記録として捨てる（toISOString の RangeError も防ぐ）
export const MIN_TIME_MS = Date.UTC(2000, 0, 1);
export const MAX_TIME_MS = Date.UTC(2100, 0, 1);

export function isSaneTime(ms: number): boolean {
  return Number.isFinite(ms) && ms >= MIN_TIME_MS && ms < MAX_TIME_MS;
}

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
  return `${new Date(sec + JST_OFFSET_MS).toISOString().slice(0, 19)}${JST_OFFSET}`;
}

// sleep segment の Data Points の 1 件。Takeout は他の項目（dataTypeName など）も含むので、余分な項目は許す
const SleepPointSchema = z.object({
  startTimeNanos: NanosSchema,
  endTimeNanos: NanosSchema,
  fitValue: z
    .array(z.object({ value: z.object({ intVal: z.number().int().optional() }).optional() }))
    .optional(),
});

// Takeout の raw sleep segment JSON を Segment[] にする。形や時刻が不正な記録は捨てて stats に数える
export function parseSleepJson(json: unknown, source: string, stats?: ParseStats): Segment[] {
  const candidates = validDataPoints(json, SleepPointSchema, stats).map((p) => ({
    start: nanosToMs(p.startTimeNanos),
    end: nanosToMs(p.endTimeNanos),
    stage: p.fitValue?.[0]?.value?.intVal ?? 0,
  }));
  const valid = candidates.filter(
    (c) => isSaneTime(c.start) && isSaneTime(c.end) && c.end > c.start,
  );
  // 呼び出し側が複数ファイル分を合計するので、渡された stats に足し込む
  if (stats) stats.invalidTime += candidates.length - valid.length;
  return valid.map((c) => ({
    source,
    start: Math.round(c.start),
    end: Math.round(c.end),
    stage: c.stage,
  }));
}

// 1 ソース分の segment を、間隔が SESSION_GAP_MS 以内で連続するものを 1 セッションにまとめる
export function sessionize(segments: Segment[]): Session[] {
  const sorted = [...segments].sort((a, b) => a.start - b.start || a.end - b.end);
  const sessions: Session[] = [];
  // 末尾のセッションを延ばしながら走査する（状態を持ち回る処理）。件数が多いので配列を作り直さず、
  // この関数で作ったセッションだけを書き換える
  for (const seg of sorted) {
    const cur = sessions.at(-1);
    if (cur && seg.start - cur.end <= SESSION_GAP_MS) {
      cur.segments.push(seg);
      cur.end = Math.max(cur.end, seg.end);
    } else {
      sessions.push({
        source: seg.source,
        segments: [seg],
        start: seg.start,
        end: seg.end,
      });
    }
  }
  return sessions;
}

// 開始順のセッションを、前のまとまりの終了から NIGHT_MERGE_GAP_MS 以内に始まるものを同じまとまりにする
export function mergeNights(sessions: Session[]): Night[] {
  const sorted = [...sessions].sort((a, b) => a.start - b.start || a.end - b.end);
  const nights: Night[] = [];
  // sessionize と同じく、末尾のまとまりを延ばしながら走査する
  for (const s of sorted) {
    const cur = nights.at(-1);
    if (cur && s.start - cur.end <= NIGHT_MERGE_GAP_MS) {
      cur.sessions.push(s);
      cur.end = Math.max(cur.end, s.end);
    } else {
      nights.push({ source: s.source, sessions: [s], start: s.start, end: s.end });
    }
  }
  return nights;
}

const isAwake = (stage: number) => stage === SLEEP_STAGE.awake || stage === SLEEP_STAGE.outOfBed;

// 浅い・深い・REM のどれか（ステージの区別がある記録）
const isStagedSleep = (stage: number) =>
  stage === SLEEP_STAGE.light || stage === SLEEP_STAGE.deep || stage === SLEEP_STAGE.rem;

const nightHasStages = (n: Night) =>
  n.sessions.some((s) => s.segments.some((g) => isStagedSleep(g.stage)));

function stageMs(s: Session, pred: (stage: number) => boolean): number {
  return s.segments.filter((g) => pred(g.stage)).reduce((t, g) => t + g.end - g.start, 0);
}

const nightStageMs = (n: Night, pred: (stage: number) => boolean) =>
  n.sessions.reduce((t, s) => t + stageMs(s, pred), 0);

// まとまりの中で、どの segment にも覆われていない時間の合計
function gapMs(n: Night): number {
  const segs = n.sessions.flatMap((s) => s.segments).sort((a, b) => a.start - b.start);
  // 走査しながら「ここまでの終端」を持ち回る処理なので let にする
  let total = 0;
  let end = n.start;
  for (const g of segs) {
    if (g.start > end) total += g.start - end;
    end = Math.max(end, g.end);
  }
  return total;
}

// 覚醒のステージと、segment の間の隙間の合計。隙間は中途覚醒に数える
// （Android でセッション間の間隔を数えるのと揃える）
const nightAwakeMs = (n: Night) => nightStageMs(n, isAwake) + gapMs(n);

// まとまりの睡眠時間 = ベッド内時間 −（覚醒 + 隙間）。本睡眠と仮眠で同じ式を使う
const nightAsleepMs = (n: Night) => Math.max(0, n.end - n.start - nightAwakeMs(n));

export function summarizeNight(n: Night): {
  sleep: SleepFields;
  hasStages: boolean;
} {
  const hasStages = nightHasStages(n);
  const minutesOf = (stage: number) =>
    Math.round(nightStageMs(n, (x) => x === stage) / MS_PER_MINUTE);
  const sleep: SleepFields = {
    start: jstIso(n.start),
    end: jstIso(n.end),
    in_bed_minutes: Math.round((n.end - n.start) / MS_PER_MINUTE),
    awake_minutes: Math.round(nightAwakeMs(n) / MS_PER_MINUTE),
    asleep_minutes: Math.round(nightAsleepMs(n) / MS_PER_MINUTE),
    ...(hasStages
      ? {
          deep_minutes: minutesOf(SLEEP_STAGE.deep),
          light_minutes: minutesOf(SLEEP_STAGE.light),
          rem_minutes: minutesOf(SLEEP_STAGE.rem),
        }
      : {}),
  };
  return { sleep, hasStages };
}

const hasStagedSleep = (nights: Night[]) => nights.some(nightHasStages);

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

// 1 日分のまとまりから採用する睡眠を作る。最長のまとまりを main に（同長なら先に起きた方）、残りは仮眠
function chooseSleep(sources: Map<string, Night[]>): ChosenSleep {
  const [source, nights] = pickSource(sources);
  const main = nights.reduce((best, n) => (n.end - n.start > best.end - best.start ? n : best));
  const { sleep, hasStages } = summarizeNight(main);
  // 仮眠もまとまりごとに数え、まとまりの中の隙間は睡眠に入れない
  const naps = nights.filter((n) => n !== main);
  if (naps.length === 0) return { source, sleep, hasStages };
  const napMinutes = Math.round(naps.reduce((t, n) => t + nightAsleepMs(n), 0) / MS_PER_MINUTE);
  return { source, sleep: { ...sleep, nap_minutes: napMinutes }, hasStages };
}

// 全ソースの segment から、起床日(JST)ごとに採用する睡眠を決める
export function buildSleepByDate(segments: Segment[]): Map<string, ChosenSleep> {
  // ソース・日付への振り分けは Map に足していく（lib が ES2023 で Map.groupBy を使えないため）
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
      const m = byDate.get(date) ?? new Map<string, Night[]>();
      byDate.set(date, m);
      const list = m.get(source);
      if (list) list.push(night);
      else m.set(source, [night]);
    }
  }

  return new Map([...byDate].map(([date, sources]) => [date, chooseSleep(sources)]));
}
