import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildDays } from "../src/takeout/index.js";
import { DAILY_CSV_PATH, loadTakeout, RAW_DIR } from "../src/takeout/load.js";

const nanos = (iso: string) => String(Date.parse(iso) * 1e6);

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("loadTakeout", () => {
  it("時刻が不正な記録を捨てた件数を返し、取り込みは続ける", async () => {
    root = await mkdtemp(join(tmpdir(), "takeout-"));
    await mkdir(join(root, DAILY_CSV_PATH[0]!), { recursive: true });
    await mkdir(join(root, RAW_DIR), { recursive: true });
    await writeFile(join(root, ...DAILY_CSV_PATH), "日付,歩数\n2026-03-10,1000\n");
    await writeFile(
      join(root, RAW_DIR, "raw_com.google.sleep.segment_app.a.json"),
      JSON.stringify({
        "Data Points": [
          {
            fitValue: [{ value: { intVal: 4 } }],
            startTimeNanos: nanos("2026-03-09T23:00:00+09:00"),
            endTimeNanos: nanos("2026-03-10T06:00:00+09:00"),
          },
          { fitValue: [{ value: { intVal: 4 } }], startTimeNanos: "0", endTimeNanos: "1e30" },
        ],
      }),
    );
    await writeFile(
      join(root, RAW_DIR, "raw_com.google.nutrition_app.b.json"),
      JSON.stringify({
        "Data Points": [
          {
            startTimeNanos: "9e30",
            fitValue: [{ value: { mapVal: [{ key: "calories", value: { fpVal: 100 } }] } }],
          },
        ],
      }),
    );

    const loaded = await loadTakeout(root);
    expect(loaded.dropped).toEqual({ sleep: 1, nutrition: 1 });
    expect(loaded.segments).toHaveLength(1);
    expect(loaded.nutrition).toEqual([]);
    const { days } = buildDays(loaded.csvDays, loaded.segments, {}, loaded.nutrition);
    expect(days.map((d) => d.date)).toEqual(["2026-03-10"]);
    expect(days[0]?.sleep?.in_bed_minutes).toBe(420);
  });
});
