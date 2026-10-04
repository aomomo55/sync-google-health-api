import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  DailySummarySchema,
  DateSchema,
  pickSections,
  SECTIONS,
  type Section,
} from "../domain/daily.js";
import { inclusiveDays, inclusiveMonths, isRealMonth } from "../domain/dates.js";
import { summarizeMonths } from "../domain/monthly.js";
import type { HealthStore } from "../store/health-store.js";
import type { NoteSync } from "../sync/note-sync.js";

const MAX_INGEST_DAYS = 400;
const MAX_SPAN_DAYS = 400;
const MAX_SPAN_MONTHS = 120;

const SyncNotesSchema = z.strictObject({
  from: DateSchema,
  to: DateSchema,
  includeStatic: z.boolean().optional(),
});

const IngestSchema = z.strictObject({
  days: z
    .array(DailySummarySchema)
    .min(1)
    .max(MAX_INGEST_DAYS)
    .refine(
      (days) => new Set(days.map((d) => d.date)).size === days.length,
      "date が重複しています",
    ),
});

function summarizeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 10)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}

function badRequest(message: string): never {
  throw new HTTPException(400, { message });
}

function parseWith<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const r = schema.safeParse(value);
  if (!r.success) badRequest(`${label}: ${summarizeIssues(r.error)}`);
  return r.data;
}

function parseTypes(raw: string | undefined): Section[] | undefined {
  if (raw === undefined) return undefined;
  const items = raw.split(",").map((s) => s.trim());
  const bad = items.filter((s) => !(SECTIONS as readonly string[]).includes(s));
  if (bad.length > 0) {
    badRequest(`types が不正です: ${bad.join(",")}（使用可能: ${SECTIONS.join(",")}）`);
  }
  return items as Section[];
}

export function healthRoutes(store: HealthStore, noteSync: NoteSync | null = null) {
  const r = new Hono();

  r.post(
    "/ingest",
    bodyLimit({
      maxSize: 2 * 1024 * 1024,
      onError: (c) => c.json({ error: "Payload Too Large" }, 413),
    }),
    async (c) => {
      const raw: unknown = await c.req.json().catch(() => badRequest("JSON が不正です"));
      const { days } = parseWith(IngestSchema, raw, "リクエストが不正です");
      const { written } = await store.upsertDays(days);
      if (!noteSync) return c.json({ written, notes: null });
      // 保存は済んでいるので、ノート同期の失敗は 200 で知らせる
      try {
        const report = await noteSync.syncDates(days.map((d) => d.date));
        return c.json({
          written,
          notes: {
            written: report.written.length,
            unchanged: report.unchanged.length,
            failed: report.failed,
          },
        });
      } catch (e) {
        console.error("note sync failed", e);
        return c.json({
          written,
          notes: { error: e instanceof Error ? e.message : String(e) },
        });
      }
    },
  );

  r.post(
    "/notes/sync",
    bodyLimit({
      maxSize: 16 * 1024,
      onError: (c) => c.json({ error: "Payload Too Large" }, 413),
    }),
    async (c) => {
      if (!noteSync) return c.json({ error: "Vault が設定されていません" }, 503);
      const raw: unknown = await c.req.json().catch(() => badRequest("JSON が不正です"));
      const { from, to, includeStatic } = parseWith(SyncNotesSchema, raw, "リクエストが不正です");
      const n = inclusiveDays(from, to);
      if (n < 1) badRequest("from は to 以前である必要があります");
      if (n > MAX_SPAN_DAYS) badRequest(`期間は最大 ${MAX_SPAN_DAYS} 日です`);
      const report = await noteSync.syncRange(from, to, { includeStatic });
      return c.json({
        written: report.written.length,
        unchanged: report.unchanged.length,
        failed: report.failed,
      });
    },
  );

  r.get("/summary/monthly", async (c) => {
    const from = c.req.query("from");
    const to = c.req.query("to");
    if (!from || !to || !isRealMonth(from) || !isRealMonth(to)) {
      badRequest("from と to は YYYY-MM 形式で指定してください");
    }
    const n = inclusiveMonths(from, to);
    if (n < 1) badRequest("from は to 以前である必要があります");
    if (n > MAX_SPAN_MONTHS) badRequest(`期間は最大 ${MAX_SPAN_MONTHS} か月です`);
    // 文字列キー比較なので月末は -31 で足りる
    const days = await store.getDays(`${from}-01`, `${to}-31`);
    return c.json({ months: summarizeMonths(days) });
  });

  r.get("/summary", async (c) => {
    const date = c.req.query("date");
    const from = c.req.query("from");
    const to = c.req.query("to");
    const types = parseTypes(c.req.query("types"));

    let start: string;
    let end: string;
    if (date !== undefined && from === undefined && to === undefined) {
      start = end = parseWith(DateSchema, date, "date");
    } else if (date === undefined && from !== undefined && to !== undefined) {
      start = parseWith(DateSchema, from, "from");
      end = parseWith(DateSchema, to, "to");
      const n = inclusiveDays(start, end);
      if (n < 1) badRequest("from は to 以前である必要があります");
      if (n > MAX_SPAN_DAYS) badRequest(`期間は最大 ${MAX_SPAN_DAYS} 日です`);
    } else {
      badRequest("date、または from と to のどちらか一方を指定してください");
    }

    const days = await store.getDays(start, end);
    return c.json({
      days: types ? days.map((d) => pickSections(d, types)) : days,
    });
  });

  return r;
}
