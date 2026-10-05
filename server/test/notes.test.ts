import { describe, expect, it } from "vitest";
import type { DailySummary } from "../src/domain/daily.js";
import { summarizeMonth } from "../src/domain/monthly.js";
import {
  MEMO_MARKER,
  MemoMarkerMissingError,
  mergeMemo,
  notePaths,
  renderAllStaticNotes,
  renderDailyLogBase,
  renderDailyNote,
  renderHealthDashboard,
  renderMonthlyBase,
  renderMonthlyNote,
  renderSleepDashboard,
  renderSleepLogBase,
} from "../src/notes/index.js";
import { needsQuote, yamlScalar } from "../src/notes/yaml.js";

const fullDay: DailySummary = {
  date: "2026-03-15",
  activity: {
    steps: 9000,
    distance_m: 6200,
    calories_kcal: 2000.4,
    move_minutes: 90,
    heart_points: 20,
    vigorous_minutes: 20,
    walking_minutes: 60,
  },
  heart_rate: { avg_bpm: 70.4, max_bpm: 120, min_bpm: 50 },
  body: {},
  nutrition: { energy_kcal: 1850.4, protein_g: 70.04, fat_g: 60, carbs_g: 220 },
  sleep: {
    start: "2026-03-14T22:30:00+09:00",
    end: "2026-03-14T21:30:00Z", // = 06:30 JST (別オフセット)
    asleep_minutes: 450,
    in_bed_minutes: 480,
    awake_minutes: 30,
    deep_minutes: 100,
    light_minutes: 290,
    rem_minutes: 60,
  },
};

function fm(note: string): string[] {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(note);
  expect(m).not.toBeNull();
  return m![1]!.split("\n");
}

// 平坦な frontmatter の簡易パーサ（キー順と値の検査用）
function parseFm(note: string): [string, string][] {
  return fm(note)
    .filter((l) => /^[^\s-][^:]*:/.test(l))
    .map((l) => {
      const i = l.indexOf(":");
      return [l.slice(0, i), l.slice(i + 1).trim()] as [string, string];
    });
}

const DAILY_KEYS = [
  "type",
  "日付",
  "曜日",
  "歩数",
  "距離km",
  "消費カロリー",
  "摂取カロリー",
  "たんぱく質g",
  "脂質g",
  "炭水化物g",
  "運動時間",
  "強めの運動",
  "ハートポイント",
  "ウォーキング分",
  "平均心拍",
  "最大心拍",
  "最小心拍",
  "安静時心拍",
  "体重kg",
  "体脂肪率",
  "就寝時刻",
  "起床時刻",
  "睡眠時間h",
  "ベッド内時間h",
  "中途覚醒分",
  "深い睡眠分",
  "浅い睡眠分",
  "REM睡眠分",
  "仮眠分",
  "8000歩達成",
  "7時間以上",
  "tags",
];

describe("paths", () => {
  it("既定の Health ルート", () => {
    const p = notePaths();
    expect(p.daily("2026-03-15")).toBe("Health/Daily/2026-03-15.md");
    expect(p.monthly("2026-03")).toBe("Health/Monthly/2026-03.md");
    expect(p.dashboard).toBe("Health/ヘルスケアダッシュボード.md");
    expect(p.sleepDashboard).toBe("Health/睡眠ダッシュボード.md");
    expect(p.dailyBase).toBe("Health/_bases/日次ログ.base");
    expect(p.sleepBase).toBe("Health/_bases/睡眠ログ.base");
    expect(p.monthlyBase).toBe("Health/_bases/月次サマリー.base");
  });
  it("ルートを変更できる（前後のスラッシュは除去）", () => {
    expect(notePaths("/Vault/Health/").daily("2026-01-02")).toBe(
      "Vault/Health/Daily/2026-01-02.md",
    );
  });
});

describe("yaml", () => {
  it("スカラー", () => {
    expect(yamlScalar(12)).toBe("12");
    expect(yamlScalar(5.22)).toBe("5.22");
    expect(yamlScalar(true)).toBe("true");
    expect(yamlScalar(false)).toBe("false");
    expect(yamlScalar(null)).toBe("");
    expect(yamlScalar(undefined)).toBe("");
    expect(yamlScalar(Number.NaN)).toBe("");
  });
  it("引用が必要な文字列", () => {
    for (const s of [
      "",
      "true",
      "No",
      "null",
      "123",
      "1.5",
      "2026-03-15",
      "a: b",
      "# x",
      "- x",
      " pad",
      "[a]",
      "'q'",
      "~",
    ]) {
      expect(needsQuote(s), s).toBe(true);
    }
    for (const s of ["health-daily", "日", "health/daily"]) expect(needsQuote(s), s).toBe(false);
  });
  it("quote 指定の時刻・月は常に引用、特殊文字はエスケープ", () => {
    expect(yamlScalar("22:30", { quote: true })).toBe('"22:30"');
    expect(yamlScalar("2026-03", { quote: true })).toBe('"2026-03"');
    expect(yamlScalar('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(yamlScalar("2026-03-15", { raw: true })).toBe("2026-03-15");
  });
});

describe("renderDailyNote", () => {
  it("全フィールドの golden", () => {
    const note = renderDailyNote(fullDay, { prev: "2026-03-14", next: "2026-03-16" });
    expect(note).toBe(`---
type: health-daily
日付: 2026-03-15
曜日: 日
歩数: 9000
距離km: 6.2
消費カロリー: 2000
摂取カロリー: 1850
たんぱく質g: 70
脂質g: 60
炭水化物g: 220
運動時間: 90
強めの運動: 20
ハートポイント: 20
ウォーキング分: 60
平均心拍: 70.4
最大心拍: 120
最小心拍: 50
安静時心拍:
体重kg:
体脂肪率:
就寝時刻: "22:30"
起床時刻: "06:30"
睡眠時間h: 7.5
ベッド内時間h: 8
中途覚醒分: 30
深い睡眠分: 100
浅い睡眠分: 290
REM睡眠分: 60
仮眠分:
8000歩達成: true
7時間以上: true
tags:
  - health/daily
---

# 2026-03-15（日）

- 活動: 9,000歩 / 6.2 km / 運動 1時間30分
- 食事: 1,850 kcal（P 70g / F 60g / C 220g）
- 心拍: 平均 70.4 bpm / 50〜120
- 睡眠: 22:30 → 06:30 / 睡眠 7時間30分 / 内訳 深い 100分・浅い 290分・REM 60分

← [[Health/Daily/2026-03-14|前日]] | [[Health/Monthly/2026-03|2026年3月]] | [[Health/Daily/2026-03-16|翌日]] →

${MEMO_MARKER}
## メモ
`);
  });

  it("歩数のみのスパースなノート。キーと順序は常に同じ", () => {
    const note = renderDailyNote(
      { date: "2026-03-16", activity: { steps: 100 } },
      { prev: "2026-03-15" },
    );
    const rows = parseFm(note);
    expect(rows.map(([k]) => k)).toEqual(DAILY_KEYS);
    const get = (k: string) => rows.find(([x]) => x === k)![1];
    expect(get("歩数")).toBe("100");
    expect(get("曜日")).toBe("月");
    expect(get("8000歩達成")).toBe("false");
    expect(get("7時間以上")).toBe("");
    expect(get("就寝時刻")).toBe("");
    expect(note).toContain("- 活動: 100歩");
    expect(note).not.toContain("- 心拍:");
    expect(note).not.toContain("- 睡眠:");
    expect(note).toContain(
      "← [[Health/Daily/2026-03-15|前日]] | [[Health/Monthly/2026-03|2026年3月]]\n",
    );
    expect(note).not.toContain("翌日");
  });

  it("データなしでもキーは揃い、サマリー行は無い", () => {
    const note = renderDailyNote({ date: "2026-03-08" }, {});
    expect(parseFm(note).map(([k]) => k)).toEqual(DAILY_KEYS);
    expect(note.split("---\n")[2]).not.toContain("- ");
    expect(note).toContain(MEMO_MARKER);
  });

  it("食事: 一部の項目だけでも出力し、無ければ行を出さない", () => {
    const only = renderDailyNote({ date: "2026-03-15", nutrition: { energy_kcal: 1200 } }, {});
    expect(only).toContain("- 食事: 1,200 kcal\n");
    expect(only).toContain("摂取カロリー: 1200\n");
    expect(only).toContain("たんぱく質g:\n");
    const pfc = renderDailyNote(
      { date: "2026-03-15", nutrition: { protein_g: 50.5, fat_g: 30 } },
      {},
    );
    expect(pfc).toContain("- 食事: P 50.5g / F 30g\n");
    expect(renderDailyNote({ date: "2026-03-15", nutrition: {} }, {})).not.toContain("- 食事:");
  });

  it("睡眠時刻は入力オフセットによらず JST", () => {
    const note = renderDailyNote(
      {
        date: "2026-01-02",
        sleep: { start: "2026-01-01T14:30:00Z", end: "2026-01-01T21:00:00-05:00" },
      },
      {},
    );
    expect(note).toContain('就寝時刻: "23:30"');
    expect(note).toContain('起床時刻: "11:00"');
  });

  it("体重・仮眠・達成フラグ", () => {
    const note = renderDailyNote(
      {
        date: "2026-03-15",
        body: { weight_kg: 60.5 },
        sleep: { asleep_minutes: 420, nap_minutes: 30 },
      },
      {},
    );
    expect(note).toContain("体重kg: 60.5");
    expect(note).toContain("7時間以上: true");
    expect(note).toContain("- 仮眠: 30分");
    expect(note).toContain("- 体重: 60.5 kg");
  });

  it("決定的（2回描画して同一）", () => {
    expect(renderDailyNote(fullDay, { prev: "a" })).toBe(renderDailyNote(fullDay, { prev: "a" }));
  });
});

describe("mergeMemo", () => {
  const generated = renderDailyNote(fullDay, {});
  const withMemo = (memo: string) => generated + memo;

  it("既存なしなら generated", () => {
    expect(mergeMemo(null, generated)).toBe(generated);
  });
  it("空や空白だけの既存は generated で置換", () => {
    expect(mergeMemo("", generated)).toBe(generated);
    expect(mergeMemo(" \n\t\r\n", generated)).toBe(generated);
  });
  it("マーカーなしの空でない既存は上書きせず throw", () => {
    expect(() => mergeMemo("# 手書きのノート\n本文\n", generated)).toThrow(MemoMarkerMissingError);
    expect(() => mergeMemo("# 手書きのノート\n本文\n", generated)).toThrow(/health:memo/);
  });
  it("ユーザーのメモを保持し、上側は再生成", () => {
    const old = renderDailyNote({ date: "2026-03-15", activity: { steps: 1 } }, {});
    const existing = withMemo("今日は雨だった\n- [ ] todo\n").replace("12,855", "0");
    const merged = mergeMemo(`${old}今日は雨だった\n`, generated);
    expect(merged.startsWith(generated.slice(0, generated.indexOf("%% health:memo")))).toBe(true);
    expect(merged.endsWith("## メモ\n今日は雨だった\n")).toBe(true);
    expect(merged).toBe(mergeMemo(merged, generated)); // 冪等
    expect(existing).toContain("雨");
  });
  it("メモ以降は一字一句そのまま（マーカー行の書き換えも保持）", () => {
    const existing = "古い上部\n%% health:memo — custom %%\n## メモ\n自分の文章\n\n\n末尾";
    const merged = mergeMemo(existing, generated);
    expect(merged.endsWith("%% health:memo — custom %%\n## メモ\n自分の文章\n\n\n末尾")).toBe(true);
    expect(merged).not.toContain("古い上部");
    expect(merged).toContain("# 2026-03-15（日）");
  });
  it("CRLF の既存ファイルでもマーカーを検出して保持する", () => {
    const existing = `古い\r\n上部\r\n${MEMO_MARKER}\r\n## メモ\r\nユーザー\r\n`;
    const merged = mergeMemo(existing, generated);
    expect(merged.endsWith(`${MEMO_MARKER}\r\n## メモ\r\nユーザー\r\n`)).toBe(true);
    expect(merged).not.toContain("古い");
  });
  it("マーカーが行頭以外にしか無ければ（本文での言及）マーカー扱いしない", () => {
    expect(() => mergeMemo("text %% health:memo in line\n", generated)).toThrow(
      MemoMarkerMissingError,
    );
  });
});

describe("renderMonthlyNote", () => {
  const m = summarizeMonth("2026-03", [
    {
      date: "2026-03-01",
      activity: {
        steps: 10000,
        distance_m: 8000,
        calories_kcal: 2400.4,
        move_minutes: 60,
        walking_minutes: 40.4,
      },
      nutrition: { energy_kcal: 1850, protein_g: 70.04, fat_g: 60, carbs_g: 220 },
      heart_rate: { avg_bpm: 70 },
      body: { weight_kg: 60 },
      sleep: {
        start: "2026-02-28T23:00:00+09:00",
        end: "2026-03-01T06:00:00+09:00",
        asleep_minutes: 420,
        in_bed_minutes: 450,
        deep_minutes: 100,
        light_minutes: 200,
        rem_minutes: 60,
        nap_minutes: 20,
      },
    },
  ]);

  it("golden", () => {
    expect(renderMonthlyNote(m)).toBe(`---
type: health-monthly
月: "2026-03"
月初日: 2026-03-01
計測日数: 1
平均歩数: 10000
平均消費カロリー: 2400
総距離km: 8
運動時間合計: 60
ウォーキング分合計: 40
摂取記録日数: 1
平均摂取カロリー: 1850
平均たんぱく質g: 70
平均脂質g: 60
平均炭水化物g: 220
平均心拍: 70
平均体重kg: 60
睡眠記録日数: 1
平均睡眠時間h: 7
平均ベッド内時間h: 7.5
平均就寝時刻: "23:00"
平均起床時刻: "06:00"
仮眠合計分: 20
平均深い睡眠分: 100
平均浅い睡眠分: 200
平均REM睡眠分: 60
tags:
  - health/monthly
---

# 2026年3月の健康サマリー

- 計測日数: 1日
- 活動: 平均 10,000歩/日 / 合計 8 km / 運動 1時間0分
- 食事: 1日記録 / 平均 1,850 kcal/日 / P 70g / F 60g / C 220g
- 平均心拍: 70 bpm
- 平均体重: 60 kg
- 睡眠: 1夜 / 平均 7 時間 / 23:00 → 06:00

← [[Health/Monthly/2026-02|2026年2月]] | [[Health/Monthly/2026-04|2026年4月]] →

## 日別一覧

\`\`\`dataview
TABLE 歩数, 摂取カロリー, 距離km, 運動時間, 平均心拍, 睡眠時間h, 就寝時刻, 起床時刻
FROM "Health/Daily"
WHERE type = "health-daily" AND dateformat(日付, "yyyy-MM") = "2026-03"
SORT 日付 ASC
\`\`\`
`);
  });

  it("空の月でもキーは揃い、月跨ぎのリンクが正しい", () => {
    const e = renderMonthlyNote(summarizeMonth("2026-01", []));
    expect(parseFm(e)).toHaveLength(26);
    expect(parseFm(e).find(([k]) => k === "平均歩数")![1]).toBe("");
    expect(e).toContain("[[Health/Monthly/2025-12|2025年12月]]");
    expect(e).toContain("[[Health/Monthly/2026-02|2026年2月]]");
    expect(renderMonthlyNote(summarizeMonth("2026-12", []))).toContain(
      "[[Health/Monthly/2027-01|2027年1月]]",
    );
  });

  it("決定的", () => {
    expect(renderMonthlyNote(m)).toBe(renderMonthlyNote(m));
  });
});

describe("静的ノート", () => {
  const jsBlocks = (md: string) =>
    [...md.matchAll(/```dataviewjs\n([\s\S]*?)\n```/g)].map((x) => x[1]!);

  it("ヘルスケアダッシュボードの埋め込み・リンク・グラフ", () => {
    const d = renderHealthDashboard();
    expect(d).toContain("## 直近90日");
    expect(d).toContain("![[Health/_bases/日次ログ.base#直近90日]]");
    expect(d).toContain("## 月次の推移");
    expect(d).toContain("![[Health/_bases/月次サマリー.base]]");
    expect(d).toContain("[[Health/睡眠ダッシュボード|睡眠ダッシュボード]]");
    expect(d).toContain("Health Connect");
    expect(jsBlocks(d)).toHaveLength(8);
    expect(d).toContain("## カロリー");
    expect(d.indexOf("## カロリー")).toBeGreaterThan(d.indexOf("## 直近90日"));
    expect(d.indexOf("## カロリー")).toBeLessThan(d.indexOf("## 月次の推移"));
    expect(d).toContain("摂取カロリー");
    expect(d).toContain("平均摂取カロリー");
    expect(d).toContain("window.renderChart");
    expect(d).toContain("dv.pages('\"Health/Daily\"')");
    expect(d).toContain("dv.pages('\"Health/Monthly\"')");
  });

  it("睡眠ダッシュボード", () => {
    const d = renderSleepDashboard();
    expect(d).toContain("![[Health/_bases/睡眠ログ.base#直近90夜]]");
    expect(d).toContain("stacked: true");
    expect(d).toContain("h + 24");
    expect(d).toContain("[[Health/ヘルスケアダッシュボード|ヘルスケアダッシュボード]]");
    expect(jsBlocks(d)).toHaveLength(6);
    // 直近1週間の睡眠時間が一番上にある
    expect(d.indexOf("## 直近1週間の睡眠時間")).toBeLessThan(d.indexOf("## 直近90夜"));
  });

  it("直近1週間の睡眠時間は 7 日分を並べ、記録の無い日は空ける", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: dataviewjs の動的な API を模したモックのため
    const calls: any[] = [];
    const page = (d: string, h: number) => ({
      type: "health-daily",
      日付: { toFormat: () => d },
      睡眠時間h: h,
    });
    const arr = {
      where: () => arr,
      sort: () => arr,
      array: () => [page("2026-03-10", 6.5), page("2026-03-15", 7.25)],
    };
    const dv = {
      date: () => ({
        minus: ({ days }: { days: number }) => ({
          toFormat: () => `2026-03-${String(15 - days).padStart(2, "0")}`,
        }),
      }),
      pages: () => arr,
      paragraph: () => {},
    };
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
      ...a: string[]
    ) => (...a: unknown[]) => Promise<void>;
    await new AsyncFunction("dv", "window", jsBlocks(renderSleepDashboard())[0]!).call(
      { container: {} },
      dv,
      { renderChart: (c: unknown) => calls.push(c) },
    );
    expect(calls[0].data.labels).toEqual([
      "03-09",
      "03-10",
      "03-11",
      "03-12",
      "03-13",
      "03-14",
      "03-15",
    ]);
    expect(calls[0].data.datasets[0].data).toEqual([null, 6.5, null, null, null, null, 7.25]);
    expect(calls[0].data.datasets[1].data).toEqual([7, 7, 7, 7, 7, 7, 7]);
  });

  it("全 dataviewjs ブロックは構文的に正しく、データ 0 件でも例外なし", async () => {
    const blocks = [...jsBlocks(renderHealthDashboard()), ...jsBlocks(renderSleepDashboard())];
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
      ...a: string[]
    ) => (...a: unknown[]) => Promise<void>;
    for (const code of blocks) {
      const fn = new AsyncFunction("dv", "window", code);
      const msgs: string[] = [];
      const empty = {
        date: () => ({
          minus: ({ days }: { days: number }) => ({
            toFormat: () => `2026-03-${String(15 - days).padStart(2, "0")}`,
          }),
        }),
        pages: () => {
          const arr = { where: () => arr, sort: () => arr, array: () => [] as unknown[] };
          return arr;
        },
        paragraph: (s: string) => msgs.push(s),
      };
      await fn.call({ container: {} }, empty, { renderChart: () => {} });
      expect(msgs.length).toBe(1);
    }
  });

  it("実データ相当でグラフ設定が生成される", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: dataviewjs の動的な API を模したモックのため
    const calls: any[] = [];
    const page = (d: string) => ({
      type: "health-daily",
      日付: { toFormat: () => d },
      歩数: 9000,
      平均心拍: null,
      体重kg: null,
      睡眠時間h: 7,
      就寝時刻: "00:30",
      起床時刻: "07:00",
      深い睡眠分: 100,
      浅い睡眠分: 200,
      REM睡眠分: 50,
      中途覚醒分: 5,
    });
    const arr = {
      where: () => arr,
      sort: () => arr,
      array: () => [page("2026-03-01"), page("2026-03-02")],
    };
    const dv = {
      date: () => ({
        minus: ({ days }: { days: number }) => ({
          toFormat: () => `2026-03-${String(15 - days).padStart(2, "0")}`,
        }),
      }),
      pages: () => arr,
      paragraph: () => {},
    };
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
      ...a: string[]
    ) => (...a: unknown[]) => Promise<void>;
    const blocks = jsBlocks(renderSleepDashboard());
    // 3番目: 就寝・起床時刻
    await new AsyncFunction("dv", "window", blocks[2]!).call({ container: {} }, dv, {
      renderChart: (c: unknown) => calls.push(c),
    });
    const ds = calls[0].data.datasets;
    expect(ds[0].data).toEqual([24.5, 24.5]); // 00:30 は +24
    expect(ds[1].data).toEqual([7, 7]);
    expect(calls[0].data.labels).toEqual(["2026-03-01", "2026-03-02"]);
  });

  it("Bases: フィルタ・ビュー・列", () => {
    const d = renderDailyLogBase();
    expect(d).toContain('file.inFolder("Health/Daily")');
    expect(d).toContain("'type == \"health-daily\"'");
    expect(d).toContain("name: 直近90日");
    expect(d).toContain("name: 全期間");
    expect(d).toContain('today() - "90d"');
    expect(d).toContain("direction: DESC");
    for (const c of [
      "日付",
      "曜日",
      "歩数",
      "距離km",
      "運動時間",
      "摂取カロリー",
      "平均心拍",
      "体重kg",
      "8000歩達成",
    ]) {
      expect(d).toContain(`- note.${c}\n`);
    }
    const s = renderSleepLogBase();
    expect(s).toContain("name: 直近90夜");
    expect(s).toContain("- 'note.睡眠時間h'");
    for (const c of ["就寝時刻", "REM睡眠分", "中途覚醒分", "仮眠分", "7時間以上"]) {
      expect(s).toContain(`- note.${c}\n`);
    }
    const mb = renderMonthlyBase();
    expect(mb).toContain('file.inFolder("Health/Monthly")');
    expect(mb).toContain("property: note.月初日");
    expect(mb).toContain("direction: DESC");
    expect(mb).toContain("- note.平均消費カロリー\n");
    expect(mb).toContain("- note.平均摂取カロリー\n");
  });

  it("Bases の埋め込み先ビュー名が実在する", () => {
    const dash = renderHealthDashboard();
    expect(renderDailyLogBase()).toContain(`name: ${/日次ログ\.base#(.+?)\]\]/.exec(dash)![1]}`);
    expect(renderSleepLogBase()).toContain(
      `name: ${/睡眠ログ\.base#(.+?)\]\]/.exec(renderSleepDashboard())![1]}`,
    );
  });

  it("renderAllStaticNotes は 5 ファイルを返し、決定的", () => {
    const a = renderAllStaticNotes();
    expect(a.map((f) => f.path)).toEqual([
      "Health/ヘルスケアダッシュボード.md",
      "Health/睡眠ダッシュボード.md",
      "Health/_bases/日次ログ.base",
      "Health/_bases/睡眠ログ.base",
      "Health/_bases/月次サマリー.base",
    ]);
    expect(renderAllStaticNotes()).toEqual(a);
    expect(renderAllStaticNotes("Vault")[0]!.path).toBe("Vault/ヘルスケアダッシュボード.md");
    expect(renderHealthDashboard("Vault")).toContain("![[Vault/_bases/日次ログ.base#直近90日]]");
  });
});
