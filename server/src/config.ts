import { z } from "zod";
import { isAgeRecipient } from "./backup/backup.js";
import { DEFAULT_VAULT_PREFIX } from "./vault/vault-writer.js";

// API_TOKEN の規則。CLI（scripts/cli-guard.ts）の検査でも使う
export const MIN_API_TOKEN_LENGTH = 32;
// Hono の bearerAuth が受け付ける文字（RFC 6750 の b64token）
export const BEARER_TOKEN_PATTERN = /^[A-Za-z0-9._~+/-]+=*$/;
// トークンを平文で送ってよい、ローカルでの試験用のホスト
export const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
// エラーメッセージに並べる表記。一覧を変えたときにメッセージが食い違わないよう、定数から作る
export const LOCAL_HOSTS_LABEL = [...LOCAL_HOSTS].join(" / ");
// fly.io のプライベートネットワークのホスト名の末尾。通信は fly.io の WireGuard の中だけを通る
const FLY_PRIVATE_HOST_SUFFIXES = [".internal", ".flycast"];

// 端末に貼り付けたときに紛れ込む制御文字（ESC など）は HTTP ヘッダーに使えず、
// 実行時に原因の分かりにくい "fetch failed" になるため起動時に弾く
const token = (min: number) =>
  z
    .string()
    .min(min, `${min}文字以上が必要です`)
    .regex(/^[\x21-\x7e]+$/, "空白・改行・制御文字・全角文字を含めないでください");
// bearerAuth が受け付ける文字に限る。それ以外の文字を含むと起動はできても全リクエストが 400 になる
const bearerToken = token(MIN_API_TOKEN_LENGTH).regex(
  BEARER_TOKEN_PATTERN,
  "英数字と . _ ~ + / - （末尾の = は可）だけで指定してください",
);
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

// https: か、平文でも外のネットワークを通らないホストへの http: かを確かめる。
// どのホストに http: を許すかは、送る相手ごとに isHttpAllowedHost で決める
const isHttpsOrAllowedHttp = (u: URL, isHttpAllowedHost: (hostname: string) => boolean): boolean =>
  u.protocol === "https:" || (u.protocol === "http:" && isHttpAllowedHost(u.hostname));
const isLocalHost = (hostname: string): boolean => LOCAL_HOSTS.has(hostname);
const isLocalOrFlyPrivateHost = (hostname: string): boolean =>
  isLocalHost(hostname) || FLY_PRIVATE_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix));

// Basic 認証のパスワードを平文で流さないため https: に限る。
// http: はローカルでの試験用の localhost と、fly.io のプライベートネットワークのホストだけ許す。
// 資格情報を URL に含めると、fetch の失敗時にパスワード入りの URL がエラーメッセージ経由でログに出る
const couchdbUrl = z
  .url()
  .refine(
    (v) => {
      const u = parseUrl(v);
      return !u || isHttpsOrAllowedHttp(u, isLocalOrFlyPrivateHost);
    },
    {
      message: `https: の URL を指定してください（http: は ${LOCAL_HOSTS_LABEL} と、fly.io のプライベートネットワークの ${FLY_PRIVATE_HOST_SUFFIXES.join(" / ")} のみ可）`,
    },
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

// トークンを平文で流さないため https: に限る。ローカルでの試験用に localhost だけ http: を許す
const obsidianMcpUrl = z
  .url()
  .refine(
    (v) => {
      const u = parseUrl(v);
      return !u || isHttpsOrAllowedHttp(u, isLocalHost);
    },
    {
      message: `https: の URL を指定してください（http: は ${LOCAL_HOSTS_LABEL} のみ可）`,
    },
  )
  // COUCHDB_URL と同じく、fetch の失敗時に資格情報入りの URL がエラー文に出るのを防ぐ
  .refine(
    (v) => {
      const u = parseUrl(v);
      return !u || (u.username === "" && u.password === "");
    },
    {
      message:
        "URL にユーザー名・パスワードを含めないでください（OBSIDIAN_MCP_TOKEN を使ってください）",
    },
  );

// ノートのパスや dataviewjs のコードに埋め込むため、引用符や記号、`.` / `..` を入れられないようにする。
// フォルダ名の前後の空白は貼り付けの混入とみなして弾く（obsidian-sync-mcp の許可フォルダとずれるため）
const PREFIX_SEGMENT = "[\\p{L}\\p{N}_-](?:[\\p{L}\\p{N} _-]*[\\p{L}\\p{N}_-])?";
const vaultPrefix = z
  .string()
  .regex(
    new RegExp(`^${PREFIX_SEGMENT}(?:/${PREFIX_SEGMENT})*/?$`, "u"),
    "文字・数字・空白・_・- からなるフォルダ名を / で区切って指定してください（先頭の / や . / ..、フォルダ名の前後の空白は不可）",
  );

// CouchDB への接続情報。サーバーの設定と、復元の CLI（scripts/restore-backup.ts）で同じ検査を使う
const couchdbConnection = {
  COUCHDB_URL: couchdbUrl,
  COUCHDB_USER: credential,
  COUCHDB_PASSWORD: credential,
};
const couchdbConnectionSchema = z.object(couchdbConnection);

const schema = z
  .object({
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    API_TOKEN: bearerToken,
    ...couchdbConnection,
    COUCHDB_HEALTH_DB: z.string().min(1).default("health"),
    OBSIDIAN_MCP_URL: obsidianMcpUrl.optional(),
    OBSIDIAN_MCP_TOKEN: token(16).optional(),
    VAULT_HEALTH_PREFIX: vaultPrefix.default(DEFAULT_VAULT_PREFIX),
    // バックアップの取得（GET /backup/health）専用。API_TOKEN とは別にし、漏れても書き込みはできないようにする
    BACKUP_TOKEN: bearerToken.optional(),
    // バックアップを暗号化する age の公開鍵（age1...）。秘密鍵はサーバーに置かない
    BACKUP_AGE_RECIPIENT: z
      .string()
      .refine(isAgeRecipient, "age の公開鍵（age1...）を指定してください")
      .optional(),
    NODE_ENV: z.string().optional(),
  })
  .refine((c) => !!c.OBSIDIAN_MCP_URL === !!c.OBSIDIAN_MCP_TOKEN, {
    message: "OBSIDIAN_MCP_URL と OBSIDIAN_MCP_TOKEN は両方設定するか両方未設定にしてください",
    path: ["OBSIDIAN_MCP_URL"],
  })
  .refine((c) => !!c.BACKUP_TOKEN === !!c.BACKUP_AGE_RECIPIENT, {
    message: "BACKUP_TOKEN と BACKUP_AGE_RECIPIENT は両方設定するか両方未設定にしてください",
    path: ["BACKUP_TOKEN"],
  })
  .refine((c) => c.BACKUP_TOKEN === undefined || c.BACKUP_TOKEN !== c.API_TOKEN, {
    message: "BACKUP_TOKEN には API_TOKEN と別の値を指定してください",
    path: ["BACKUP_TOKEN"],
  });

export type Config = z.infer<typeof schema>;
export type CouchdbConnection = z.infer<typeof couchdbConnectionSchema>;

type Env = Record<string, string | undefined>;

// 検査に失敗したら、どの環境変数がなぜ不正かだけを並べて投げる
function parseEnv<T>(target: z.ZodType<T>, env: Env): T {
  const result = target.safeParse(env);
  if (!result.success) {
    const details = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    // 値そのものはログに出さない（トークン漏洩防止）
    throw new Error(`環境変数が不正です:\n${details}`);
  }
  return result.data;
}

export function loadConfig(env: Env = process.env): Config {
  return parseEnv(schema, env);
}

/** COUCHDB_URL / COUCHDB_USER / COUCHDB_PASSWORD だけを、サーバーの設定と同じ規則で検査する */
export function loadCouchdbConnection(env: Env = process.env): CouchdbConnection {
  return parseEnv(couchdbConnectionSchema, env);
}
