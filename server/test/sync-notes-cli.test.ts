import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

// sync:notes を実際に起動し、手元に立てた偽のサーバーへ向けて確かめる
const run = promisify(execFile);
const SERVER_DIR = fileURLToPath(new URL("..", import.meta.url));
const TOKEN = "t".repeat(32);
// tsx の起動を含めて待つ上限
const CLI_TEST_TIMEOUT_MS = 30_000;
// 子プロセスを打ち切るまでの時間。テストの上限より短くし、時間切れでも子プロセスを残さない
const CLI_PROCESS_TIMEOUT_MS = 20_000;

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

// 決まった応答を返す偽のサーバーを立て、受けたリクエストの数を数える
async function startServer(
  status: number,
  body: unknown,
): Promise<{ url: string; hits: () => number }> {
  const requests: unknown[] = [];
  const s = createServer((req, res) => {
    requests.push(req.url);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  server = s;
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const { port } = s.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, hits: () => requests.length };
}

async function runCli(apiUrl: string): Promise<{ code: number; stdout: string; stderr: string }> {
  // 10 日を 5 日ずつ、2 区間に分けて送らせる
  // node_modules/.bin/tsx は Windows では直接起動できないので、Node に tsx を読み込ませて起動する
  const args = [
    "--import",
    "tsx",
    "scripts/sync-notes.ts",
    "--from",
    "2026-01-01",
    "--to",
    "2026-01-10",
    "--days",
    "5",
  ];
  const options = {
    cwd: SERVER_DIR,
    env: { ...process.env, API_TOKEN: TOKEN },
    timeout: CLI_PROCESS_TIMEOUT_MS,
  };
  try {
    const { stdout, stderr } = await run(process.execPath, [...args, "--api-url", apiUrl], options);
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code: number; stdout: string; stderr: string };
    return { code: err.code, stdout: err.stdout, stderr: err.stderr };
  }
}

describe("sync:notes", () => {
  it(
    "404 はやり直さず、Vault の設定を確かめるよう案内してすぐ止まる",
    async () => {
      const srv = await startServer(404, { error: "Not Found" });
      const r = await runCli(srv.url);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/OBSIDIAN_MCP_URL \/ OBSIDIAN_MCP_TOKEN.*古い版.*--api-url にパス/);
      // 2 区間あるが、最初の 1 回で止まる
      expect(srv.hits()).toBe(1);
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    "想定外の形の応答は、区間の失敗として終了コード 1",
    async () => {
      const srv = await startServer(200, { written: "3" });
      const r = await runCli(srv.url);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("応答の形が想定外です");
      expect(srv.hits()).toBe(2);
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    "正しい応答なら区間ごとの件数と合計を表示する",
    async () => {
      const srv = await startServer(200, { written: 1, unchanged: 4, failed: [] });
      const r = await runCli(srv.url);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("合計: 書き込み 2 / 変更なし 8 / 失敗 0");
    },
    CLI_TEST_TIMEOUT_MS,
  );
});
