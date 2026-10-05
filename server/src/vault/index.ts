import { McpVaultWriter } from "./mcp-vault-writer.js";
import type { VaultWriter } from "./vault-writer.js";

// 設定（Config）には依存せず、必要な値だけを受け取る。URL かトークンが無ければ null（Vault 連携なし）
export function createVaultWriter(opts: {
  url: string | undefined;
  token: string | undefined;
  prefix: string;
}): VaultWriter | null {
  if (!opts.url || !opts.token) return null;
  return new McpVaultWriter({ url: opts.url, token: opts.token, prefix: opts.prefix });
}

export { McpVaultWriter } from "./mcp-vault-writer.js";
export { MemoryVaultWriter } from "./memory-vault-writer.js";
export * from "./vault-writer.js";
