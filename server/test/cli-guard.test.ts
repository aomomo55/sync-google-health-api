import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  checkApiToken,
  checkApiUrl,
  describeError,
  isTimeoutError,
  REQUEST_TIMEOUT_MS,
  scrubToken,
} from "../scripts/cli-guard.js";

const VALID = "abcdefghijklmnopqrstuvwxyz012345";

describe("checkApiToken", () => {
  it("規則に合うトークンを受け付ける", () => {
    expect(checkApiToken(VALID)).toBeUndefined();
    expect(checkApiToken(`${VALID}._~+/-==`)).toBeUndefined();
  });

  it("未設定・短すぎるトークンを拒否する", () => {
    expect(checkApiToken(undefined)).toMatch(/未設定/);
    expect(checkApiToken("")).toMatch(/未設定/);
    expect(checkApiToken("short")).toMatch(/32 文字以上/);
  });

  it.each([
    ["改行", `${VALID}\n`],
    ["CR", `${VALID}\r`],
    ["NUL", `${VALID}\u0000`],
    ["ESC", `\u001b[200~${VALID}`],
    ["空白", `${VALID} `],
    ["途中の =", `abc=${VALID}`],
    ["全角", `${VALID}あ`],
  ])("%s を含むトークンを拒否し、値をメッセージに含めない", (_, token) => {
    const msg = checkApiToken(token);
    expect(msg).toMatch(/使えない文字/);
    expect(msg).not.toContain(VALID);
  });
});

describe("checkApiUrl", () => {
  it.each([
    "https://example.test",
    "https://example.test/",
    "http://localhost:8080",
    "http://127.0.0.1:8080/",
    "http://[::1]:8080",
  ])("%s を受け付ける", (url) => {
    expect(checkApiUrl(url)).toBeUndefined();
  });

  it("未指定・不正な URL を拒否する", () => {
    expect(checkApiUrl(undefined)).toMatch(/指定してください/);
    expect(checkApiUrl("example.test")).toMatch(/解釈できません/);
  });

  it.each([
    "http://example.test",
    "http://localhost.example.test",
    "http://192.168.0.10:8080",
    "ftp://example.test",
  ])("%s を拒否する", (url) => {
    expect(checkApiUrl(url)).toMatch(/https:\/\//);
  });

  it("ユーザー名・パスワードを含む URL を拒否する", () => {
    expect(checkApiUrl("https://user:pass@example.test")).toMatch(/ユーザー名/);
    expect(checkApiUrl("https://user@example.test")).toMatch(/ユーザー名/);
  });
});

describe("scrubToken", () => {
  it("トークンをすべて *** に置き換える", () => {
    expect(scrubToken(`Bearer ${VALID} / ${VALID}`, VALID)).toBe("Bearer *** / ***");
  });

  it("トークンが無ければそのまま返す", () => {
    expect(scrubToken("fetch failed", undefined)).toBe("fetch failed");
    expect(scrubToken("fetch failed", "")).toBe("fetch failed");
  });
});

describe("describeError", () => {
  it("cause を含め、トークンを伏せる", () => {
    const e = new Error(`Headers.append: "Bearer ${VALID}" is an invalid header value`, {
      cause: { code: "ECONNREFUSED", message: `connect ${VALID}` },
    });
    const text = describeError(e, VALID);
    expect(text).not.toContain(VALID);
    expect(text).toBe(
      'Headers.append: "Bearer ***" is an invalid header value (ECONNREFUSED: connect ***)',
    );
  });

  it("Error 以外も文字列にしてトークンを伏せる", () => {
    expect(describeError(`x ${VALID}`, VALID)).toBe("x ***");
  });
});

describe("isTimeoutError", () => {
  // 応答を返さないサーバーへ、短いタイムアウトで fetch したときの実際の例外で確かめる
  const SHORT_TIMEOUT_MS = 50;

  async function fetchHangingServer(): Promise<unknown> {
    const server = createServer(() => {});
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(SHORT_TIMEOUT_MS) });
      return undefined;
    } catch (e) {
      return e;
    } finally {
      server.closeAllConnections();
      server.close();
    }
  }

  it("fetch のタイムアウトを判定し、秒数の分かるメッセージにする", async () => {
    const e = await fetchHangingServer();
    expect(isTimeoutError(e)).toBe(true);
    expect(describeError(e, VALID)).toBe(
      `サーバーが ${REQUEST_TIMEOUT_MS / 1000} 秒以内に応答しませんでした`,
    );
  });

  it("タイムアウト以外は false", () => {
    expect(isTimeoutError(new Error("fetch failed"))).toBe(false);
    expect(isTimeoutError(new DOMException("aborted", "AbortError"))).toBe(false);
    expect(isTimeoutError(null)).toBe(false);
    expect(isTimeoutError("TimeoutError")).toBe(false);
  });
});
