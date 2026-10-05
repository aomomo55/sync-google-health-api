import { z } from "zod";

// 端末に貼り付けたときに紛れ込む制御文字（ESC など）は HTTP ヘッダーに使えず、
// 実行時に原因の分かりにくい "fetch failed" になるため起動時に弾く
const token = (min: number) =>
  z
    .string()
    .min(min, `${min}文字以上が必要です`)
    .regex(/^[\x21-\x7e]+$/, "空白・改行・制御文字・全角文字を含めないでください");
const credential = z
  .string()
  .min(1)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字を弾くことが目的の検査
  .regex(/^[^\x00-\x1f\x7f]+$/, "改行や制御文字を含めないでください");

// URL として解釈できない値は z.url() 側で弾くので、refine では通す（同じ値に重ねてエラーを出さない）
const parseUrl = (v: string): URL | null => {
  try {
    return new URL(v);
  } catch {
    return null;
  }
};

// 資格情報を URL に含めると、fetch の失敗時にパスワード入りの URL がエラーメッセージ経由でログに出る
const couchdbUrl = z
  .url()
  .refine(
    (v) => {
      const u = parseUrl(v);
      return !u || u.protocol === "http:" || u.protocol === "https:";
    },
    { message: "http: または https: の URL を指定してください" },
  )
  .refine(
    (v) => {
      const u = parseUrl(v);
      return !u || (u.username === "" && u.password === "");
    },
    {
      message:
        "URL にユーザー名・パスワードを含めないでください（COUCHDB_USER / COUCHDB_PASSWORD を使ってください）",
    },
  );

const schema = z
  .object({
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    API_TOKEN: token(32),
    COUCHDB_URL: couchdbUrl,
    COUCHDB_USER: credential,
    COUCHDB_PASSWORD: credential,
    COUCHDB_HEALTH_DB: z.string().min(1).default("health"),
    OBSIDIAN_MCP_URL: z.url().optional(),
    OBSIDIAN_MCP_TOKEN: token(16).optional(),
    VAULT_HEALTH_PREFIX: z.string().min(1).default("Health/"),
    NODE_ENV: z.string().optional(),
  })
  .refine((c) => !!c.OBSIDIAN_MCP_URL === !!c.OBSIDIAN_MCP_TOKEN, {
    message: "OBSIDIAN_MCP_URL と OBSIDIAN_MCP_TOKEN は両方設定するか両方未設定にしてください",
    path: ["OBSIDIAN_MCP_URL"],
  });

export type Config = z.infer<typeof schema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const result = schema.safeParse(env);
  if (!result.success) {
    const details = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    // 値そのものはログに出さない（トークン漏洩防止）
    throw new Error(`環境変数が不正です:\n${details}`);
  }
  return result.data;
}
