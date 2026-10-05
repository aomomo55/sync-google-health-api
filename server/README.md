# sync-google-health server

Android アプリから送られる日次ヘルスデータを受け取るサーバー（Hono + Node）。
保存先は CouchDB。デプロイ先は fly.io を想定。

## 環境変数

| 名前 | 必須 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `PORT` | いいえ | `8080` | 待ち受けポート |
| `API_TOKEN` | はい | - | `/api/*` 用の Bearer トークン（32文字以上） |
| `COUCHDB_URL` | はい | - | CouchDB のベース URL |
| `COUCHDB_USER` | はい | - | CouchDB ユーザー |
| `COUCHDB_PASSWORD` | はい | - | CouchDB パスワード |
| `COUCHDB_HEALTH_DB` | いいえ | `health` | データベース名（起動時に無ければ作成） |
| `OBSIDIAN_MCP_URL` | いいえ | - | obsidian-sync-mcp の `/mcp` URL（`OBSIDIAN_MCP_TOKEN` と両方指定するか両方未設定） |
| `OBSIDIAN_MCP_TOKEN` | いいえ | - | obsidian-sync-mcp 用 Bearer トークン（16文字以上） |
| `VAULT_HEALTH_PREFIX` | いいえ | `Health/` | Vault 内で書き込みを許可するフォルダ。ノートもこの下に生成する |
| `NODE_ENV` | いいえ | - | 実行環境 |

ローカル開発では `server/dev.vars`（gitignore 済み）に `KEY=value` 形式で書く。

```
API_TOKEN=ここに32文字以上のランダム文字列
PORT=8080
COUCHDB_URL=http://localhost:5984
COUCHDB_USER=admin
COUCHDB_PASSWORD=ここにパスワード
```

トークン生成例: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

## コマンド

```sh
pnpm install
pnpm dev         # tsx watch（dev.vars を読み込む）
pnpm test        # vitest
pnpm typecheck   # tsc --noEmit
pnpm build       # dist/ へ出力
pnpm start       # node dist/index.js（環境変数は自前で渡す）
```

## エンドポイント

- `GET /healthz` — 認証なし。`{"status":"ok"}`
- `GET /api/ping` — `Authorization: Bearer <API_TOKEN>` 必須。`{"pong":true}`
- `POST /api/ingest` — `{"days":[DailySummary]}`（1〜400件、日付重複不可）。セクション単位でマージ保存し（セクションは `activity` / `heart_rate` / `body` / `sleep` / `nutrition`）、Vault 設定があれば影響するノート（該当日・前後の日・月次）を同期する。`{"written":n,"notes":{"written":n,"unchanged":n,"failed":[{"path","error"}]}}`。Vault 未設定なら `notes:null`、同期が例外で失敗しても保存済みなので 200 で `notes:{"error":"..."}`
- `POST /api/notes/sync` — `{"from":"YYYY-MM-DD","to":"YYYY-MM-DD","includeStatic":bool?}`（最大400日）。範囲内のノートを再生成し、内容が同じものは書き込まない。`{"written":n,"unchanged":n,"failed":[...]}`。Vault 未設定は 503
- `GET /api/summary?date=YYYY-MM-DD` または `?from=&to=`（最大400日）— `{"days":[...]}`。`types=activity,heart_rate,body,sleep,nutrition` で絞り込み
- `GET /api/summary/monthly?from=YYYY-MM&to=YYYY-MM`（最大120か月）— 月次集計 `{"months":[...]}`（データのある月のみ）

### nutrition セクション

食事の摂取量。日合計を `nutrition: {energy_kcal, protein_g, fat_g, carbs_g}` で送る（0 以上の数値。他のセクションと同じく、項目の省略は既存値を残し、`null` は値を消す）。`activity.calories_kcal` は消費カロリーで、摂取とは別。月次集計には `activity.avg_calories_kcal`（消費の平均）と `nutrition`（`days_logged`、`avg_energy_kcal`、`avg_protein_g`、`avg_fat_g`、`avg_carbs_g`。値のある日だけで平均）が加わる。

Vault 統合テスト: `OBSIDIAN_MCP_TEST_URL` と `OBSIDIAN_MCP_TEST_TOKEN` を設定すると実 obsidian-sync-mcp 向けテストが走る（未設定ならスキップ）。

統合テスト: `COUCHDB_TEST_URL=http://user:pass@host:5984` を設定すると実 CouchDB 向けテストが走る（未設定ならスキップ）。

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

- `--from` / `--to`（YYYY-MM-DD）で期間を絞れる。`--takeout` の代わりに環境変数 `TAKEOUT_DIR` でもよい
- 睡眠は複数アプリの記録が重なるため、起床日ごとに 1 つのソースだけ採用する。その日にステージ (4/5/6 = 浅い/深い/REM) を含むソースを優先し、その中で合計時間が最長のもの、同点ならソース ID の辞書順で最小のものを選ぶ。区間の間隔が 60 分以内なら同じ睡眠とみなし、その日で最も長いものを本睡眠、残りを仮眠とする
- 食事は 1 データポイントが 1 食（1 品）で、`fitValue[0]` の `mapVal` から `calories` / `protein` / `fat.total` / `carbs.total` を読み、開始時刻の日付（JST）ごとに合計する（摂取カロリーは整数、P/F/C は小数 1 桁）。値の無い項目は出力しない。複数ソースに同じ日の記録があるときは、その日の記録件数が最も多いソースだけを使い（合算しない）、同数なら合計 kcal が大きいもの、それも同じならソース ID の辞書順で最小のものを選ぶ。dry run の統計に `nutrition: ...` の行（日数と期間）が出る

## ノートの一括同期（バックフィル）

Takeout 取り込み後などに、保存済みデータから Vault のノートをまとめて作る。サーバーの `POST /api/notes/sync` を 120 日ずつ呼ぶ。`API_TOKEN` は環境変数で渡す。

```sh
pnpm sync:notes --from 2022-01-01 --to 2026-09-30 --api-url http://localhost:8080 --include-static
```

- `--include-static` は最初のチャンクでダッシュボードと Bases も書く
- チャンクごとの件数と合計を表示し、失敗があれば終了コード 1
- 日次ノートのメモ欄（マーカー以降）は保持される
