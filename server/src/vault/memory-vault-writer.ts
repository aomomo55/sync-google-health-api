import {
  assertVaultPath,
  DEFAULT_VAULT_PREFIX,
  normalizePrefix,
  type VaultWriter,
} from "./vault-writer.js";

// テスト用のインメモリ実装
export class MemoryVaultWriter implements VaultWriter {
  readonly notes = new Map<string, string>();
  private readonly prefix: string;

  constructor(opts: { prefix?: string } = {}) {
    this.prefix = normalizePrefix(opts.prefix ?? DEFAULT_VAULT_PREFIX);
  }

  async writeNote(path: string, content: string): Promise<void> {
    assertVaultPath(path, this.prefix);
    this.notes.set(path, content);
  }

  async readNote(path: string): Promise<string | null> {
    assertVaultPath(path, this.prefix);
    return this.notes.get(path) ?? null;
  }

  async close(): Promise<void> {}
}
