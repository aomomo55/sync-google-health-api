import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { issuePath } from "../src/shared/issue-path.js";
import { round } from "../src/shared/rounding.js";

// shared の決まり（ADR 0016）を機械的に確かめる
const SHARED_DIR = join(dirname(fileURLToPath(import.meta.url)), "../src/shared");
const FORBIDDEN_NAMES = ["utils", "helpers", "common", "misc", "lib", "index"];

const sharedFiles = () => readdirSync(SHARED_DIR).filter((f) => f.endsWith(".ts"));

describe("shared の決まり", () => {
  it("中身を表さない名前のファイルや、バレル（index.ts）を置かない", () => {
    const names = sharedFiles().map((f) => basename(f, ".ts"));
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((n) => FORBIDDEN_NAMES.includes(n))).toEqual([]);
  });

  it("shared から他の層を import しない", () => {
    const outside = sharedFiles().flatMap((f) => {
      const src = readFileSync(join(SHARED_DIR, f), "utf8");
      return [...src.matchAll(/from\s+"(\.\.\/[^"]+)"/g)].map((m) => `${f}: ${m[1]}`);
    });
    expect(outside).toEqual([]);
  });
});

describe("round", () => {
  it("指定した桁で四捨五入する", () => {
    expect(round(1.25, 1)).toBe(1.3);
    expect(round(1234.5678, 2)).toBe(1234.57);
    expect(round(2.5, 0)).toBe(3);
    expect(round(-2.5, 0)).toBe(-2);
  });
});

describe("issuePath", () => {
  it("場所を . でつなぎ、全体のエラーは (root) にする", () => {
    expect(issuePath({ path: ["activity", "steps"] })).toBe("activity.steps");
    expect(issuePath({ path: ["days", 0, "date"] })).toBe("days.0.date");
    expect(issuePath({ path: [] })).toBe("(root)");
  });
});
