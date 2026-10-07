// CLI（import:takeout / sync:notes）で共通の入力検査、サーバーへの通信のタイムアウト、エラー表示からのトークン除去

// トークンの規則とローカルのホストは、サーバーの設定の検査と同じものを使う
import { BEARER_TOKEN_PATTERN, LOCAL_HOSTS, MIN_API_TOKEN_LENGTH } from "../src/config.js";

/** 問題があればエラーメッセージを返す。メッセージにトークンの値は含めない */
export function checkApiToken(token: string | undefined): string | undefined {
  if (!token) return "環境変数 API_TOKEN が未設定です";
  if (!BEARER_TOKEN_PATTERN.test(token)) {
    return "環境変数 API_TOKEN に使えない文字が含まれています（英数字と . _ ~ + / - のみ、末尾に = 可）。貼り付け時に改行・空白・制御文字が混入していないか確認してください";
  }
  if (token.length < MIN_API_TOKEN_LENGTH) {
    return `環境変数 API_TOKEN は ${MIN_API_TOKEN_LENGTH} 文字以上にしてください`;
  }
  return undefined;
}

function parseUrl(raw: string): URL | undefined {
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

/** https のみ許可する（localhost / 127.0.0.1 / [::1] だけは http も可）。問題があればエラーメッセージを返す */
export function checkApiUrl(raw: string | undefined): string | undefined {
  if (!raw) return "--api-url を指定してください";
  const url = parseUrl(raw);
  if (!url) return "--api-url が URL として解釈できません";
  if (url.username || url.password) {
    return "--api-url にユーザー名やパスワードを含めないでください";
  }
  if (url.protocol === "https:") return undefined;
  if (url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname)) return undefined;
  return "--api-url は https:// で指定してください（http:// は localhost / 127.0.0.1 / [::1] のみ可）";
}

// サーバーへの 1 回の通信（応答本文の読み込みまで）を待つ上限。サーバーは受信や同期の中で
// ノートを書き込み、obsidian-sync-mcp の呼び出しは 1 回 60 秒まで待って一時的な失敗をやり直すので、
// 数百日分のバッチでは数分かかりうる。それより十分長く、止まったままだと気付ける長さにする
export const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const MS_PER_SECOND = 1000;

/** fetch が REQUEST_TIMEOUT_MS を過ぎて中断されたか */
export function isTimeoutError(e: unknown): boolean {
  return (e as { name?: unknown } | null)?.name === "TimeoutError";
}

/** 表示する文字列に含まれるトークンを *** に置き換える */
export function scrubToken(text: string, token: string | undefined): string {
  if (!token) return text;
  return text.split(token).join("***");
}

/**
 * 例外を表示用の文字列にする。fetch failed だけでは原因が分からないので、cause（タイムアウト、
 * 接続拒否など）も含める。例外のメッセージにヘッダーの値が入ることがあるので、トークンは伏せる
 */
export function describeError(e: unknown, token: string | undefined): string {
  if (isTimeoutError(e)) {
    return `サーバーが ${REQUEST_TIMEOUT_MS / MS_PER_SECOND} 秒以内に応答しませんでした`;
  }
  if (!(e instanceof Error)) return scrubToken(String(e), token);
  const cause = e.cause as { code?: string; message?: string } | undefined;
  const detail = cause ? ` (${[cause.code, cause.message].filter(Boolean).join(": ")})` : "";
  return scrubToken(`${e.message}${detail}`, token);
}
