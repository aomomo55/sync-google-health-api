// CLI（import:takeout / sync:notes）で共通の入力検査と、エラー表示からのトークン除去

// サーバーの API_TOKEN と同じ規則（Hono の bearerAuth が受け付ける形式）
const TOKEN_PATTERN = /^[A-Za-z0-9._~+/-]+=*$/;
export const MIN_TOKEN_LENGTH = 32;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** 問題があればエラーメッセージを返す。メッセージにトークンの値は含めない */
export function checkApiToken(token: string | undefined): string | undefined {
  if (!token) return "環境変数 API_TOKEN が未設定です";
  if (!TOKEN_PATTERN.test(token)) {
    return "環境変数 API_TOKEN に使えない文字が含まれています（英数字と . _ ~ + / - のみ、末尾に = 可）。貼り付け時に改行・空白・制御文字が混入していないか確認してください";
  }
  if (token.length < MIN_TOKEN_LENGTH) {
    return `環境変数 API_TOKEN は ${MIN_TOKEN_LENGTH} 文字以上にしてください`;
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
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return undefined;
  return "--api-url は https:// で指定してください（http:// は localhost / 127.0.0.1 / [::1] のみ可）";
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
  if (!(e instanceof Error)) return scrubToken(String(e), token);
  const cause = e.cause as { code?: string; message?: string } | undefined;
  const detail = cause ? ` (${[cause.code, cause.message].filter(Boolean).join(": ")})` : "";
  return scrubToken(`${e.message}${detail}`, token);
}
