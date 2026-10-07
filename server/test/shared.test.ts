import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { issuePath } from "../src/shared/issue-path.js";
import { round } from "../src/shared/rounding.js";

// shared の決まり（ADR 0016）を機械的に確かめる
const SHARED_DIR = join(dirname(fileURLToPath(import.meta.url)), "../src/shared");
const FORBIDDEN_NAMES = ["utils", "helpers", "common", "misc", "lib", "index"];
// import / export ... from、副作用だけの import、動的 import の指定子
const SPECIFIER_RE = /(?:\bfrom|\bimport)\s*\(?\s*["']([^"']+)["']/g;

// サブフォルダも含めた、shared の中の .ts の相対パス
const sharedFiles = () =>
  readdirSync(SHARED_DIR, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts"));

// ファイル名・フォルダ名を - _ . と大文字の前で区切った語（string-utils → string, utils）
const nameWords = (path: string) =>
  path
    .replace(/\.ts$/, "")
    .split(sep)
    .flatMap((part) => part.split(/[-_.]|(?=[A-Z])/))
    .map((w) => w.toLowerCase());

describe("shared の決まり", () => {
  it("中身を表さない名前のファイル・フォルダや、バレル（index.ts）を置かない", () => {
    const files = sharedFiles();
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((f) => nameWords(f).some((w) => FORBIDDEN_NAMES.includes(w)))).toEqual([]);
  });

  it("shared から他の層を import しない", () => {
    const outside = sharedFiles().flatMap((f) => {
      const src = readFileSync(join(SHARED_DIR, f), "utf8");
      return [...src.matchAll(SPECIFIER_RE)]
        .map((m) => m[1]!)
        .filter((spec) => spec.startsWith("."))
        .filter((spec) =>
          relative(SHARED_DIR, resolve(SHARED_DIR, dirname(f), spec)).startsWith(".."),
        )
        .map((spec) => `${f}: ${spec}`);
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
