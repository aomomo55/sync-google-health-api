import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

// obsidian-sync-mcp の write_note / read_note の応答形式を真似たテスト用 MCP サーバー
export class FakeObsidianMcp {
  readonly notes = new Map<string, string>();
  readonly sessions = new Map<string, StreamableHTTPServerTransport>();
  toolCalls = 0;
  initializes = 0;
  inflight = 0;
  maxInflight = 0;
  // 次の tools/call に対して返す HTTP ステータス（消費される）
  failToolCalls: number[] = [];
  toolDelayMs = 0;
  // read_note がパスごとに返す応答（ノート不在以外のエラーなどを再現する）
  readonly readResponses = new Map<string, { text: string; isError: boolean }>();
  // 次の write_note / read_note がツールのエラーとして返す文言（消費される）
  toolErrors: string[] = [];
  private server!: Server;
  url = "";

  constructor(private readonly token: string) {}

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    const port = (this.server.address() as AddressInfo).port;
    this.url = `http://127.0.0.1:${port}/mcp`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  // サーバー再起動相当（セッションを全て失う）
  dropSessions(): void {
    this.sessions.clear();
  }

  private buildMcp(): McpServer {
    const mcp = new McpServer({ name: "fake-obsidian", version: "0.7.1" });
    const text = (t: string, isError = false) => ({
      content: [{ type: "text" as const, text: t }],
      ...(isError ? { isError: true } : {}),
    });
    const denied = (path: string) =>
      !path.startsWith("Health/")
        ? text(`Write access denied: '${path}' is outside the writable folders (Health/).`, true)
        : null;
    mcp.registerTool(
      "write_note",
      { inputSchema: { path: z.string(), content: z.string() } },
      async ({ path, content }) => {
        this.toolCalls++;
        this.inflight++;
        this.maxInflight = Math.max(this.maxInflight, this.inflight);
        try {
          if (this.toolDelayMs) {
            await new Promise((r) => setTimeout(r, this.toolDelayMs));
          }
          const injected = this.toolErrors.shift();
          if (injected !== undefined) return text(injected, true);
          const d = denied(path);
          if (d) return d;
          if (path.includes("boom")) return text("Error: disk full");
          this.notes.set(path, content);
          return text(`Note saved: ${path}\n[Open in Obsidian](obsidian://open?path=${path})`);
        } finally {
          this.inflight--;
        }
      },
    );
    mcp.registerTool("read_note", { inputSchema: { path: z.string() } }, async ({ path }) => {
      this.toolCalls++;
      const injected = this.toolErrors.shift();
      if (injected !== undefined) return text(injected, true);
      const forced = this.readResponses.get(path);
      if (forced) return text(forced.text, forced.isError);
      const body = this.notes.get(path);
      // 実機（obsidian-sync-mcp）と同じく、不在は isError なしの文字列で返す
      if (body === undefined) return text(`Note not found: ${path}`);
      return text(`[Open in Obsidian](obsidian://open?path=${path})\n\n---\n\n${body}`);
    });
    return mcp;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.headers.authorization !== `Bearer ${this.token}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    let body: unknown;
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    }
    const msg = body as { method?: string } | undefined;
    if (msg?.method === "tools/call" && this.failToolCalls.length > 0) {
      const status = this.failToolCalls.shift()!;
      res.writeHead(status, { "content-type": "text/plain" });
      res.end("injected failure");
      return;
    }
    const sid = req.headers["mcp-session-id"];
    if (typeof sid === "string") {
      const t = this.sessions.get(sid);
      if (!t) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Session not found" }));
        return;
      }
      await t.handleRequest(req, res, body);
      return;
    }
    if (req.method === "POST" && msg?.method === "initialize") {
      this.initializes++;
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          this.sessions.set(id, transport);
        },
      });
      await this.buildMcp().connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "No valid session ID provided" }));
  }
}
