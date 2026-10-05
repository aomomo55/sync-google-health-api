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

export const DEFAULT_VAULT_PREFIX = "Health/";

// Vault 内の書き込み可能パスかをクライアント側で検証する（違反時は throw）
export function assertVaultPath(path: string, prefix: string): void {
  const ok =
    path.startsWith(prefix) &&
    path.length > prefix.length &&
    (path.endsWith(".md") || path.endsWith(".base")) &&
    !path.includes("..") &&
    !path.includes("\\") &&
    !path.startsWith("/");
  if (!ok) {
    throw new VaultWriteError(
      `不正な Vault パスです: '${path}'（${prefix} 配下の .md/.base のみ可）`,
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

export interface WriteManyItem {
  path: string;
  content: string;
}

export interface WriteManyOptions {
  concurrency?: number;
  onProgress?: (done: number, total: number, path: string) => void;
}

export interface WriteManyResult {
  written: number;
  failed: { path: string; error: string }[];
}

// 個々の失敗では止めず、最後に成功数と失敗一覧を返す
export async function writeMany(
  writer: VaultWriter,
  items: WriteManyItem[],
  opts: WriteManyOptions = {},
): Promise<WriteManyResult> {
  const concurrency = Math.max(1, opts.concurrency ?? 3);
  const result: WriteManyResult = { written: 0, failed: [] };
  let next = 0;
  let done = 0;

  async function worker() {
    while (next < items.length) {
      const item = items[next++]!;
      try {
        await writer.writeNote(item.path, item.content);
        result.written++;
      } catch (e) {
        result.failed.push({
          path: item.path,
          error: e instanceof Error ? e.message : String(e),
        });
      }
      done++;
      opts.onProgress?.(done, items.length, item.path);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return result;
}
