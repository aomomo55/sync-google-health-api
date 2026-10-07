export interface VaultWriter {
  writeNote(path: string, content: string): Promise<void>;
  // ノートが無ければ null。ノート本文のみを返す（"[Open in Obsidian](...)" の前置きは除く）
  readNote(path: string): Promise<string | null>;
  close(): Promise<void>;
}

export class VaultWriteError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "VaultWriteError";
  }
}

// 書き込み先のパスが許可範囲の外（設定の見直しが必要）
export class VaultPathError extends VaultWriteError {
  constructor(message: string) {
    super(message);
    this.name = "VaultPathError";
  }
}

export const DEFAULT_VAULT_PREFIX = "Health/";

// biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字の検出が目的
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;

// Vault 内の書き込み可能パスかをクライアント側で検証する（違反時は throw）
export function assertVaultPath(path: string, prefix: string): void {
  const ok =
    path.startsWith(prefix) &&
    path.length > prefix.length &&
    (path.endsWith(".md") || path.endsWith(".base")) &&
    !path.includes("..") &&
    !path.includes("\\") &&
    !path.startsWith("/") &&
    !CONTROL_CHAR_RE.test(path) &&
    path.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
  if (!ok) {
    // 制御文字がそのまま出ないよう JSON 形式で表示する
    throw new VaultPathError(
      `不正な Vault パスです: ${JSON.stringify(path)}（${prefix} 配下の .md/.base のみ可）`,
    );
  }
}

export function normalizePrefix(prefix: string): string {
  return prefix.endsWith("/") ? prefix : `${prefix}/`;
}

// 書き込みを許可するフォルダ（"Health/"）から、ノートを生成するルート（"Health"）を求める
export function noteRootFromPrefix(prefix: string): string {
  return normalizePrefix(prefix).replace(/\/+$/, "");
}

const OPEN_PREFIX_RE = /^\[Open in Obsidian\]\([^)]*\)\n\n---\n\n/;

export function stripOpenPrefix(text: string): string {
  return text.replace(OPEN_PREFIX_RE, "");
}
