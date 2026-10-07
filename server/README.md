# sync-google-health server

Android アプリから送られる日次ヘルスデータを受け取るサーバー（Hono + Node 24）。
保存先は CouchDB。デプロイ先は fly.io を想定。受信したデータから Obsidian のノートを作って obsidian-sync-mcp 経由で Vault に書き込み、バックアップ用に暗号化した全データを返す。

## 環境変数

| 名前 | 必須 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `PORT` | いいえ | `8080` | 待ち受けポート |
| `API_TOKEN` | はい | - | `/api/*` 用の Bearer トークン（32文字以上。使える文字は英数字と `. _ ~ + / -`、末尾の `=`） |
| `COUCHDB_URL` | はい | - | CouchDB のベース URL（`http:` / `https:`。ユーザー名・パスワードは含めず `COUCHDB_USER` / `COUCHDB_PASSWORD` で指定） |
| `COUCHDB_USER` | はい | - | CouchDB ユーザー（DB が既にあれば、管理者でなくその DB のメンバーのユーザーでよい） |
| `COUCHDB_PASSWORD` | はい | - | CouchDB パスワード |
| `COUCHDB_HEALTH_DB` | いいえ | `health` | データベース名（起動時に無ければ作成する。作るには管理者の権限が要り、作れなければ止まる） |
| `OBSIDIAN_MCP_URL` | いいえ | - | obsidian-sync-mcp の `/mcp` URL（`https:`。`http:` は `localhost` / `127.0.0.1` / `[::1]` のみ可。ユーザー名・パスワードを含む URL は不可。`OBSIDIAN_MCP_TOKEN` と両方指定するか両方未設定） |
| `OBSIDIAN_MCP_TOKEN` | いいえ | - | obsidian-sync-mcp 用 Bearer トークン（16文字以上） |
| `VAULT_HEALTH_PREFIX` | いいえ | `Health/` | Vault 内で書き込みを許可するフォルダ。ノートもこの下に生成する（文字・数字・空白・`_`・`-` からなるフォルダ名を `/` で区切る。先頭の `/`、`.` / `..`、空のフォルダ名、フォルダ名の前後の空白は不可） |
| `BACKUP_TOKEN` | いいえ | - | `GET /backup/health` 専用の Bearer トークン（`API_TOKEN` と同じ規則で、`API_TOKEN` とは別の値）。`BACKUP_AGE_RECIPIENT` と両方指定するか両方未設定 |
| `BACKUP_AGE_RECIPIENT` | いいえ | - | バックアップを暗号化する age の公開鍵（`age1...`）。秘密鍵はサーバーに置かない（[docs/backup.md](../docs/backup.md)） |
| `NODE_ENV` | いいえ | - | 実行環境 |

ローカル開発では `server/dev.vars`（gitignore 済み）に `KEY=value` 形式で書く。

```
API_TOKEN=ここに32文字以上のランダム文字列
PORT=8080
COUCHDB_URL=http://localhost:5984
COUCHDB_USER=admin
COUCHDB_PASSWORD=ここにパスワード
```

`COUCHDB_URL` に `http://user:pass@...` のように資格情報を含めると起動時に拒否する（接続エラーのメッセージに URL がそのまま入り、パスワードがログに出るのを防ぐため）。

トークン生成例: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

## コマンド

pnpm は `package.json` の `packageManager` にある 12.8.1 を使う。グローバルに無ければ `pnpm` を `npx --yes pnpm@12.8.1` に置き換える。

```sh
pnpm install --frozen-lockfile
pnpm dev         # tsx watch（dev.vars を読み込む）
pnpm lint        # Biome でチェックのみ（CI と同じ）
pnpm lint:fix    # Biome で自動修正
pnpm format      # Biome で整形だけ
pnpm test        # vitest
pnpm typecheck   # tsc --noEmit
pnpm build       # dist/ へ出力
pnpm start       # node dist/index.js（環境変数は自前で渡す）
```

CLI（`pnpm import:takeout` / `pnpm sync:notes` / `pnpm restore:backup`）は下の各節にある。pnpm 12 は `pnpm <スクリプト> -- --opt` の `--` もそのまま渡すが、どの CLI も先頭の `--` は読み飛ばすので、付けても付けなくてもよい。

### 結合テスト

- CouchDB: `COUCHDB_TEST_URL=http://user:pass@host:5984` を設定すると実 CouchDB 向けテストが走る（未設定ならスキップ）。CI では CouchDB のコンテナを立てて走らせている
- obsidian-sync-mcp: `OBSIDIAN_MCP_TEST_URL` と `OBSIDIAN_MCP_TEST_TOKEN` を設定すると実 obsidian-sync-mcp 向けテストが走る（未設定ならスキップ。CI では走らない）。ノート同期の結合テスト（`test/note-sync-integration.test.ts`）は `COUCHDB_TEST_URL` も要る。テスト用の Vault にだけ向けること

## エンドポイント

- `GET /healthz` — 認証なし。`{"status":"ok"}`
- `GET /api/ping` — `Authorization: Bearer <API_TOKEN>` 必須。`{"pong":true}`
- `POST /api/ingest` — `{"days":[DailySummary]}`（1〜400件、日付重複不可。本文は 2 MB まで、超えると 413）。セクション単位でマージ保存し（セクションは `activity` / `heart_rate` / `body` / `sleep` / `nutrition`）、Vault 設定があれば影響するノート（該当日・前後の日・月次）を同期する。`{"written":n,"rejected":[{"date","error"}],"notes":{"written":n,"unchanged":n,"failed":[{"path","error"}]}}`。Vault 未設定なら `notes:null`、同期が例外で失敗しても保存済みなので 200 で `notes:{"error":"..."}`。検証は 2 段（[ADR 0012](../docs/adr/0012-input-validation-and-error-exposure.md)）:
  - 形の誤り（本文の形、`days` が配列でない・空・401件以上、日付の重複、実在しない日付、未知のキー、型の違い、負の数、オフセット無しの日時など）はリクエスト全体を 400 で拒否する
  - 範囲の誤り（数値の上限超え、小数の歩数、睡眠の `end` が `start` より前）はその日だけを拒否し、他の日は通常どおり保存・同期する。拒否した日は `rejected` に日付と、項目名を挙げた日本語のエラー文で載る（値は載らない）。`rejected` は常にあり、無ければ空配列。全日が拒否されても 200 で `written:0`
  - 睡眠の `start <= end` は受け取ったデータの中だけで確かめる。片方だけを送ると、保存済みの値とマージした後の前後関係は保証されないので、クライアントは両方を一緒に送る
  - `failed[].error` と `notes.error` は、メモ欄のマーカー欠落と Vault パスの違反以外は固定の文で、詳細はサーバーのログに出る
- `POST /api/notes/sync` — `{"from":"YYYY-MM-DD","to":"YYYY-MM-DD","includeStatic":bool?}`（最大400日。本文は 16 KB まで、超えると 413）。範囲内のノートを再生成し、内容が同じものは書き込まない。`{"written":n,"unchanged":n,"failed":[...]}`。Vault 未設定は 503
- `GET /api/summary?date=YYYY-MM-DD` または `?from=&to=`（最大400日）— `{"days":[...]}`。`types=activity,heart_rate,body,sleep,nutrition` で絞り込み
- `GET /api/summary/monthly?from=YYYY-MM&to=YYYY-MM`（最大120か月）— 月次集計 `{"months":[...]}`（データのある月のみ）
- `GET /backup/health` — `Authorization: Bearer <BACKUP_TOKEN>` 必須（`API_TOKEN` では取れない）。全期間の日次データを JSON → gzip → age で暗号化して返す（`application/octet-stream`、`X-Backup-Days` に日数）。`BACKUP_TOKEN` と `BACKUP_AGE_RECIPIENT` が未設定なら 404。復元は `pnpm restore:backup`（[docs/backup.md](../docs/backup.md)）

### Vault への書き込みのやり直し

`POST /api/ingest` と `POST /api/notes/sync`（つまり `import:takeout --post` と `sync:notes` も）のノートの読み書き（obsidian-sync-mcp の `read_note` / `write_note`）は、一時的なエラーで失敗したら 1 秒・3 秒・9 秒あけて最大 3 回やり直す。やり直したことはサーバーのログに出る。

- 一時的とみなすのは、通信の失敗、HTTP の 5xx・408・429、タイムアウト、ツールが返したエラーのうち書き込みの拒否（`Write access denied`）と引数の誤り以外のもの（例: `Database write layer error!`）。HTTP の 401・403 はやり直さない
- obsidian-sync-mcp のセッションが切れた（404 など）ときは、待たずに 1 回だけつなぎ直す（上の 3 回とは別）
- 1 回の呼び出しは 60 秒で打ち切る。やり直しを使い切ると、1 つのノートに 4 分ほどかかることがある
- ツールのエラーがやり直しても直らなかったときは、全てのノートで待ち時間が積み上がらないよう、最大 60 秒はツールのエラーをやり直さない（呼び出しが 1 回成功すると解除。通信の失敗や 5xx などはこの間もやり直す）

### nutrition セクション

食事の摂取量。日合計を `nutrition: {energy_kcal, protein_g, fat_g, carbs_g}` で送る（0 以上の数値。他のセクションと同じく、項目の省略は既存値を残し、`null` は値を消す）。`activity.calories_kcal` は消費カロリーで、摂取とは別。月次集計には `activity.avg_calories_kcal`（消費の平均）と `nutrition`（`days_logged`、`avg_energy_kcal`、`avg_protein_g`、`avg_fat_g`、`avg_carbs_g`。値のある日だけで平均）が加わる。

## Google Takeout の取り込み

Google Fit 形式の Takeout から過去データを作る。対象は `日別のアクティビティ指標/日別のアクティビティ指標.csv` と、`すべてのデータ/raw_com.google.sleep.segment_*.json`（ステージ付き睡眠）、`すべてのデータ/raw_com.google.nutrition_*.json`（食事の記録。`derived_*` は使わない）。

```sh
# 試し実行: 検証して out/takeout-days.json に書き出し、件数を表示する（`--check <日付,...>` で指定した日のデータも表示）
pnpm import:takeout --takeout "<Takeout>/Takeout/Fit"

# サーバーへ送信（300日ずつ POST /api/ingest）。API_TOKEN は環境変数で渡す
pnpm import:takeout --takeout "<Takeout>/Takeout/Fit" --post --api-url http://localhost:8080

# 本番（fly.io）へは、受信時のノート書き込みで応答が遅くならないよう少しずつ送る
pnpm import:takeout --takeout "<Takeout>/Takeout/Fit" --post --batch 30 --api-url https://<アプリ名>.fly.dev
```

- 範囲外の値がある日（[ADR 0012](../docs/adr/0012-input-validation-and-error-exposure.md)）は送らずに日付と理由を表示し、サーバーが `rejected` で拒否した日もバッチごとに表示する。残りのバッチは送り続け、そうした日が 1 日でもあれば最後に終了コード 1 になる
- `--from` / `--to`（YYYY-MM-DD）で期間を絞れる。`--takeout` の代わりに環境変数 `TAKEOUT_DIR` でもよい
- `--out` で書き出し先を変えられる（既定は `out/takeout-days.json`）。`--batch` は 1 回の POST で送る日数で、1〜400（既定 300）
- 送信中は、バッチごとに送った件数と期間、サーバーが返したノートの結果（書き込み・変更なし・失敗）を表示し、最後にノートの合計を表示する
- サーバーがノートの書き込みに失敗したものがあれば、終了コード 1 になる（データは保存済みなので、`sync:notes` で同じ期間を同期し直す。拒否された日もあるときは、そちらのメッセージだけが出る）
- バッチの POST が通信エラーや 2xx 以外で失敗すると、やり直さずにそこで止まる（`sync:notes` と違う）。それまでのバッチは保存済みなので、`--from` で続きから送り直す
- 時刻が 2000〜2100 年の外にある睡眠・食事の記録は壊れたものとして捨て、件数を `dropped (invalid time): ...` の行で表示する
- 睡眠は複数アプリの記録が重なるため、起床日ごとに 1 つのソースだけ採用する。その日にステージ (4/5/6 = 浅い/深い/REM) を含むソースを優先し、その中で合計時間が最長のもの、同点ならソース ID の辞書順で最小のものを選ぶ。区間の間隔が 60 分以内なら同じセッションとみなし、さらにセッションの間隔が 2 時間以内なら一晩の睡眠として結合する（起床日は結合後の起床時刻で決める）。その日で最も長いまとまりを本睡眠、残りを仮眠とする。区間の間の隙間は中途覚醒に数える（[ADR 0013](../docs/adr/0013-merge-split-sleep-sessions.md)）
- 食事は 1 データポイントが 1 食（1 品）で、`fitValue[0]` の `mapVal` から `calories` / `protein` / `fat.total` / `carbs.total` を読み、開始時刻の日付（JST）ごとに合計する（摂取カロリーは整数、P/F/C は小数 1 桁）。値の無い項目は出力しない。複数ソースに同じ日の記録があるときは、その日の記録件数が最も多いソースだけを使い（合算しない）、同数なら合計 kcal が大きいもの、それも同じならソース ID の辞書順で最小のものを選ぶ。dry run の統計に `nutrition: ...` の行（日数と期間）が出る

## ノートの一括同期（バックフィル）

Takeout 取り込み後などに、保存済みデータから Vault のノートをまとめて作る。サーバーの `POST /api/notes/sync` を、既定では 120 日ずつ呼ぶ。`API_TOKEN` は環境変数で渡す。

```sh
pnpm sync:notes --from 2022-01-01 --to 2026-09-30 --api-url http://localhost:8080 --include-static
```

- `--from` / `--to`（YYYY-MM-DD）と `--api-url` は必須
- `--include-static` は最初のチャンクでダッシュボードと Bases も書く
- `--days` で 1 回に同期する日数を変えられる（1〜400、既定 120）。応答が遅いときは小さくする
- 通信エラーと 5xx は、5 秒・15 秒・30 秒あけて最大 3 回やり直す（同期は何度やっても同じ結果になるため）。タイムアウト（下記）はやり直さず、その区間を失敗として次の区間へ進む
- チャンクごとの件数と合計を表示し、失敗があれば終了コード 1
- 日次ノートのメモ欄（マーカー以降）は保持される。マーカーの行が無い既存の日次ノートは上書きせず失敗として表示する（マーカーを戻すかノートを削除すると、次の同期で再生成される）

両 CLI 共通（`import:takeout` は `--post` のとき）:

- `--api-url` は `https://` のみ。`http://` は `localhost` / `127.0.0.1` / `[::1]` に限る。ユーザー名・パスワードを含む URL は拒否する
- `API_TOKEN` はサーバーと同じ規則（英数字と `. _ ~ + / -`、末尾に `=` 可、32 文字以上）で起動時に検査する。貼り付けで改行・空白・制御文字が混ざると、値を表示せずに終了する
- エラー表示の中にトークンが含まれていれば `***` に置き換える
- サーバーの応答は 1 回の通信につき 10 分まで待ち、過ぎると「サーバーが 600 秒以内に応答しませんでした」と表示する。`import:takeout` はそこで止まり、`sync:notes` はその区間を失敗として扱う。`--batch` / `--days` を小さくしてやり直す

## バックアップの復元

`GET /backup/health` で取ったバックアップ（`health-YYYY-MM-DD.json.gz.age`）を復号し、空の CouchDB の DB に書き戻す。手順の全体は [docs/backup.md](../docs/backup.md#復元)。

```sh
# 中身を確かめる（書き込まない）
pnpm restore:backup --file <バックアップのファイル> --identity <age の秘密鍵のファイル> --dry-run

# 書き戻す。COUCHDB_URL / COUCHDB_USER / COUCHDB_PASSWORD は環境変数で渡す
pnpm restore:backup --file <バックアップのファイル> --identity <age の秘密鍵のファイル> --db <書き戻し先の DB 名>
```

- `<…>` は自分の値に置き換える（`<` `>` も含めて置き換える）
- `--identity` には `age-keygen` の出力ファイルを渡す。`AGE-SECRET-KEY-` で始まる行を秘密鍵として読み、中身は表示しない
- `--db` は英小文字で始まる DB 名（例: `health_restore`）。無ければ作り、文書が 1 件でもある DB には書かずに止まる（本番の DB に直接書かないため）
- 作成日時・日数・期間を表示する。形が不正な日は除いて一覧を表示し、その場合は終了コード 1
