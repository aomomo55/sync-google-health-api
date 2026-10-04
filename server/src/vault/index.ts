import type { Config } from "../config.js";
import { McpVaultWriter } from "./mcp-vault-writer.js";
import type { VaultWriter } from "./vault-writer.js";

// 未設定なら null（Vault 連携なし）
export function createVaultWriter(config: Config): VaultWriter | null {
  if (!config.OBSIDIAN_MCP_URL || !config.OBSIDIAN_MCP_TOKEN) return null;
  return new McpVaultWriter({
    url: config.OBSIDIAN_MCP_URL,
    token: config.OBSIDIAN_MCP_TOKEN,
    prefix: config.VAULT_HEALTH_PREFIX,
  });
}

export { McpVaultWriter } from "./mcp-vault-writer.js";
export { MemoryVaultWriter } from "./memory-vault-writer.js";
export * from "./vault-writer.js";
