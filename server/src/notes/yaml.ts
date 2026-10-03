// フロントマター用の最小 YAML エミッタ（スカラーと単純な文字列リストのみ）

export type YamlValue = string | number | boolean | null | undefined;

export interface YamlEntry {
  key: string;
  value: YamlValue;
  // true なら文字列を常に引用符で囲む（"HH:MM" や "YYYY-MM" など）
  quote?: boolean;
  // true なら文字列を加工せずそのまま出す（2026-03-15 のような日付）
  raw?: boolean;
}

const RESERVED = /^(true|false|yes|no|on|off|null|~|y|n)$/i;
const NUMERIC = /^[-+]?(\d[\d_]*)?\.?\d+([eE][-+]?\d+)?$|^0[xo][0-9a-f]+$|^[-+]?\.(inf|nan)$/i;
const DATELIKE = /^\d{4}-\d{2}-\d{2}/;
const SAFE_PLAIN = /^[\p{L}\p{N}][\p{L}\p{N} _./-]*$/u;

export function needsQuote(s: string): boolean {
  if (s === "" || s !== s.trim()) return true;
  if (RESERVED.test(s) || NUMERIC.test(s) || DATELIKE.test(s)) return true;
  return !SAFE_PLAIN.test(s);
}

export function yamlString(s: string): string {
  // JSON の文字列リテラルは YAML のダブルクォート文字列としても有効
  return JSON.stringify(s);
}

export function yamlScalar(v: YamlValue, opts: { quote?: boolean; raw?: boolean } = {}): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  if (opts.raw) return v;
  return opts.quote || needsQuote(v) ? yamlString(v) : v;
}

export function yamlLine(e: YamlEntry): string {
  const s = yamlScalar(e.value, e);
  return s === "" ? `${e.key}:` : `${e.key}: ${s}`;
}

export function frontmatter(entries: YamlEntry[], tags: string[]): string {
  const lines = entries.map(yamlLine);
  lines.push("tags:", ...tags.map((t) => `  - ${yamlScalar(t)}`));
  return `---\n${lines.join("\n")}\n---\n`;
}
