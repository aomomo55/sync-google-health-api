import { describe, expect, it } from "vitest";
import { McpVaultWriter } from "../src/vault/mcp-vault-writer.js";

const URL_ = process.env.OBSIDIAN_MCP_TEST_URL;
const TOKEN = process.env.OBSIDIAN_MCP_TEST_TOKEN;

describe.skipIf(!URL_ || !TOKEN)("McpVaultWriter 統合（実 obsidian-sync-mcp）", () => {
  it("書き込み・読み戻し・範囲外パスの拒否", async () => {
    const w = new McpVaultWriter({ url: URL_!, token: TOKEN! });
    try {
      const content = `# vault-writer-it\n\n${new Date().toISOString()}\n`;
      await w.writeNote("Health/_test/vault-writer-it.md", content);
      expect(await w.readNote("Health/_test/vault-writer-it.md")).toBe(content);
      expect(await w.readNote("Health/_test/not-exist.md")).toBeNull();
      // 範囲外はクライアント側ガードで弾く（送信しない）
      await expect(w.writeNote("outside.md", "x")).rejects.toThrow();
    } finally {
      await w.close();
    }
  }, 120_000);
});
