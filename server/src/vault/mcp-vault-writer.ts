import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  assertVaultPath,
  DEFAULT_VAULT_PREFIX,
  normalizePrefix,
  stripOpenPrefix,
  VaultWriteError,
  type VaultWriter,
  type WriteManyItem,
  type WriteManyOptions,
  type WriteManyResult,
  writeMany,
} from "./vault-writer.js";

export interface McpVaultWriterOptions {
  url: string;
  token: string;
  prefix?: string;
  timeoutMs?: number;
  // 一時的な失敗のリトライ間隔（ms）。要素数がリトライ回数
  retryDelaysMs?: number[];
  fetch?: typeof fetch;
}

type ErrorKind = "session" | "transient" | "permanent";

const ERROR_PREFIXES = ["Write access denied", "Error"];
const NOT_FOUND_RE = /not found|does not exist/i;

// ツールが返したエラー（リトライしない）
class ToolFailure extends VaultWriteError {}

function classify(e: unknown): ErrorKind {
  if (e instanceof ToolFailure) return "permanent";
  if (e instanceof StreamableHTTPError) {
    const code = e.code;
    if (code === 404) return "session";
    if (code === 400 && /session/i.test(e.message)) return "session";
    if (code === undefined || code === -1) return "transient";
    if (code >= 500 || code === 408 || code === 429) return "transient";
    return "permanent";
  }
  if (e instanceof McpError) {
    return e.code === ErrorCode.RequestTimeout || e.code === ErrorCode.ConnectionClosed
      ? "transient"
      : "permanent";
  }
  // fetch のネットワークエラー（TypeError: fetch failed 等）や SSE 切断
  if (e instanceof Error) {
    return e.name === "UnauthorizedError" ? "permanent" : "transient";
  }
  return "permanent";
}

function isErrorText(text: string): boolean {
  return ERROR_PREFIXES.some((p) => text.startsWith(p));
}

export class McpVaultWriter implements VaultWriter {
  private readonly url: URL;
  private readonly token: string;
  private readonly prefix: string;
  private readonly timeoutMs: number;
  private readonly delays: number[];
  private readonly fetchFn?: typeof fetch;
  private clientPromise: Promise<Client> | null = null;

  constructor(opts: McpVaultWriterOptions) {
    this.url = new URL(opts.url);
    this.token = opts.token;
    this.prefix = normalizePrefix(opts.prefix ?? DEFAULT_VAULT_PREFIX);
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.delays = opts.retryDelaysMs ?? [1000, 3000, 9000];
    this.fetchFn = opts.fetch;
  }

  async writeNote(path: string, content: string): Promise<void> {
    assertVaultPath(path, this.prefix);
    const { text, isError } = await this.callTool("write_note", { path, content });
    if (isError || isErrorText(text)) throw new ToolFailure(this.scrub(text));
  }

  async readNote(path: string): Promise<string | null> {
    assertVaultPath(path, this.prefix);
    const { text, isError } = await this.callTool("read_note", { path });
    if (text.startsWith("[Open in Obsidian]")) return stripOpenPrefix(text);
    if (NOT_FOUND_RE.test(text)) return null;
    if (isError || isErrorText(text)) throw new ToolFailure(this.scrub(text));
    return text;
  }

  writeMany(items: WriteManyItem[], opts?: WriteManyOptions): Promise<WriteManyResult> {
    return writeMany(this, items, opts);
  }

  async close(): Promise<void> {
    const p = this.clientPromise;
    this.clientPromise = null;
    if (p) await p.then((c) => c.close()).catch(() => {});
  }

  // トークンがメッセージに混入しても伏せる
  private scrub(message: string): string {
    return message.split(this.token).join("***");
  }

  private connect(): Promise<Client> {
    if (!this.clientPromise) {
      const p = (async () => {
        const client = new Client({
          name: "sync-google-health-server",
          version: "0.1.0",
        });
        const transport = new StreamableHTTPClientTransport(this.url, {
          requestInit: { headers: { Authorization: `Bearer ${this.token}` } },
          ...(this.fetchFn ? { fetch: this.fetchFn } : {}),
        });
        try {
          await client.connect(transport, { timeout: this.timeoutMs });
        } catch (e) {
          await client.close().catch(() => {});
          throw e;
        }
        return client;
      })();
      this.clientPromise = p;
      // 接続失敗は次回やり直せるようにキャッシュを捨てる
      p.catch(() => {
        if (this.clientPromise === p) this.clientPromise = null;
      });
    }
    return this.clientPromise;
  }

  private async drop(client: Client | null): Promise<void> {
    if (!client) return;
    const current = this.clientPromise ? await this.clientPromise.catch(() => null) : null;
    if (current === client) this.clientPromise = null;
    await client.close().catch(() => {});
  }

  private async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ text: string; isError: boolean }> {
    let sessionRetried = false;
    let attempt = 0;
    for (;;) {
      let client: Client | null = null;
      try {
        client = await this.connect();
        const res = await client.callTool({ name, arguments: args }, undefined, {
          timeout: this.timeoutMs,
        });
        const content = Array.isArray(res.content) ? res.content : [];
        const text = content.map((c) => (c && c.type === "text" ? String(c.text) : "")).join("");
        return { text, isError: res.isError === true };
      } catch (e) {
        const kind = classify(e);
        if (kind === "session" && !sessionRetried) {
          sessionRetried = true;
          await this.drop(client);
          continue;
        }
        if (kind !== "permanent" && attempt < this.delays.length) {
          await this.drop(client);
          await new Promise((r) => setTimeout(r, this.delays[attempt]));
          attempt++;
          continue;
        }
        const msg = e instanceof Error ? e.message : String(e);
        throw new VaultWriteError(`Vault の ${name} が失敗: ${this.scrub(msg)}`, {
          cause: e,
        });
      }
    }
  }
}
