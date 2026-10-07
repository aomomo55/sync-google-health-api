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
} from "./vault-writer.js";

export interface McpVaultWriterOptions {
  url: string;
  token: string;
  prefix?: string;
  timeoutMs?: number;
  // 一時的な失敗のリトライ間隔（ms）。要素数がリトライ回数
  retryDelaysMs?: number[];
  // ツールのエラーがやり直しても直らなかったあと、ツールのエラーをやり直さない期間（ms）
  toolRetryCooldownMs?: number;
  fetch?: typeof fetch;
}

type ErrorKind = "session" | "transient" | "permanent";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_RETRY_DELAYS_MS = [1000, 3000, 9000];
const DEFAULT_TOOL_RETRY_COOLDOWN_MS = 60_000;

const ERROR_PREFIXES = ["Write access denied", "Error"];

// ツールが返したエラーのうち、やり直しても結果が変わらないと分かっているもの
// （-32602 は引数の検証エラー）
const PERMANENT_TOOL_ERRORS = ["Write access denied", "MCP error -32602"];

// ツールが返したエラー。write_note は全体の置き換え、read_note は読むだけで、どちらも冪等なので、
// 恒久的と分かっているもの以外は一時的とみなしてやり直す（例: "Database write layer error!"）。
// 直らないエラーで待ち時間が積み上がらないよう、やり直しても失敗したあとはしばらくやり直さない
class ToolFailure extends VaultWriteError {
  readonly permanent: boolean;
  constructor(message: string) {
    super(message);
    this.permanent = PERMANENT_TOOL_ERRORS.some((p) => message.startsWith(p));
  }
}

type ToolResult = { text: string; isError: boolean };

function classify(e: unknown): ErrorKind {
  if (e instanceof ToolFailure) return e.permanent ? "permanent" : "transient";
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
  private readonly toolRetryCooldownMs: number;
  private readonly fetchFn?: typeof fetch;
  private clientPromise: Promise<Client> | null = null;
  // この時刻（epoch ms）まではツールのエラーをやり直さない。呼び出しが成功したら 0 に戻す
  private toolRetrySuspendedUntil = 0;

  constructor(opts: McpVaultWriterOptions) {
    this.url = new URL(opts.url);
    this.token = opts.token;
    this.prefix = normalizePrefix(opts.prefix ?? DEFAULT_VAULT_PREFIX);
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.delays = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.toolRetryCooldownMs = opts.toolRetryCooldownMs ?? DEFAULT_TOOL_RETRY_COOLDOWN_MS;
    this.fetchFn = opts.fetch;
  }

  async writeNote(path: string, content: string): Promise<void> {
    assertVaultPath(path, this.prefix);
    await this.callTool("write_note", { path, content }, ({ text, isError }) => {
      if (isError || isErrorText(text)) throw new ToolFailure(this.scrub(text));
    });
  }

  async readNote(path: string): Promise<string | null> {
    assertVaultPath(path, this.prefix);
    return this.callTool("read_note", { path }, ({ text, isError }) => {
      if (text.startsWith("[Open in Obsidian]")) return stripOpenPrefix(text);
      // obsidian-sync-mcp はノートが無いとき、isError を付けずに `Note not found: <path>` を返す。
      // 他のエラー（チャンク欠損など）を不在と取り違えると既存ノートを上書きするため、完全一致に限る
      if (text === `Note not found: ${path}`) return null;
      if (isError || isErrorText(text)) throw new ToolFailure(this.scrub(text));
      return text;
    });
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

  // ツールを呼び、応答を interpret で解釈する。interpret が ToolFailure を投げた場合も、
  // 通信レベルの失敗と同じくやり直しの対象になる
  private async callTool<T>(
    name: string,
    args: Record<string, unknown>,
    interpret: (res: ToolResult) => T,
  ): Promise<T> {
    // リトライの制御（回数と再接続の有無）と、catch でも使う接続は let にする
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
        const result = interpret({ text, isError: res.isError === true });
        this.toolRetrySuspendedUntil = 0;
        return result;
      } catch (e) {
        const kind = classify(e);
        if (kind === "session" && !sessionRetried) {
          sessionRetried = true;
          await this.drop(client);
          continue;
        }
        const msg = e instanceof Error ? e.message : String(e);
        const toolRetrySuspended =
          e instanceof ToolFailure && Date.now() < this.toolRetrySuspendedUntil;
        if (kind !== "permanent" && !toolRetrySuspended && attempt < this.delays.length) {
          console.warn(
            `Vault の ${name} をやり直します（${attempt + 1}/${this.delays.length} 回目）: ${this.scrub(msg)}`,
          );
          // ツールのエラーは接続に問題が無いので、セッションはそのまま使う
          if (!(e instanceof ToolFailure)) await this.drop(client);
          await new Promise((r) => setTimeout(r, this.delays[attempt]));
          attempt++;
          continue;
        }
        if (kind === "transient" && e instanceof ToolFailure && !toolRetrySuspended) {
          // 裏の DB が落ちているなど、全てのノートで同じエラーになるときに 1 件ごとに待たないようにする
          this.toolRetrySuspendedUntil = Date.now() + this.toolRetryCooldownMs;
          console.warn(
            `Vault のツールのエラーがやり直しても直らないため、${this.toolRetryCooldownMs} ms の間はツールのエラーをやり直しません`,
          );
        }
        // ツールのエラーは、やり直しの有無にかかわらず今までと同じ形で投げる
        if (e instanceof ToolFailure) throw e;
        throw new VaultWriteError(`Vault の ${name} が失敗: ${this.scrub(msg)}`, {
          cause: e,
        });
      }
    }
  }
}
