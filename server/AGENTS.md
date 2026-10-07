# server/AGENTS.md

サーバー（TypeScript / Hono）で作業するときの指示。リポジトリ全体の約束は [ルートの AGENTS.md](../AGENTS.md) にあり、合わせて読むこと。環境変数とエンドポイントは [README.md](README.md) にある。

## 構成

日次データの受信・保存（CouchDB）、Google Takeout の取り込み、Obsidian ノートの生成と obsidian-sync-mcp 経由の書き込み、暗号化したバックアップの提供と復元を行う。

- `src/domain/` 日次・月次のデータ型と集計（純粋関数）
- `src/store/` 保存先（`HealthStore`。CouchDB 実装とテスト用のメモリ実装）
- `src/notes/` ノート・ダッシュボード・Bases の生成（純粋関数、出力は決定的）
- `src/sync/` どのノートを更新するかの計画と実行
- `src/vault/` obsidian-sync-mcp を MCP クライアントとして呼ぶ書き込み
- `src/routes/` HTTP の経路（`/api/*` と `/backup/*`）。組み立ては `src/app.ts`
- `src/takeout/` Takeout（Google Fit 形式）の解析
- `src/backup/` バックアップの形式（JSON → gzip → age での暗号化と復号）
- `src/shared/` 複数の層から使う、健康データを知らない汎用の部品（純粋関数のユーティリティ、汎用の基底クラスなど）。必要になったときに作る
- `scripts/` `import:takeout`・`sync:notes`・`restore:backup` の CLI

依存の向き（これ以外の import はしない）:

- `shared` → なし（他の層を import しない）。どの層からも使ってよい（以下の一覧では省略する）
- `domain` → なし（外部ライブラリは zod のみ）
- `notes` / `store` / `takeout` / `backup` → `domain`
- `sync` → `domain` / `notes` と、`store` / `vault` のインターフェース（`HealthStore` / `VaultWriter`）
- `routes` → `domain` / `sync` / `backup` と、`store` のインターフェース
- `vault` → なし（設定の `Config` も知らない。必要な値は引数で受け取る）
- `index.ts` / `app.ts` / `config.ts` / `scripts/` → 何でもよい（設定を読み、実装を組み立てる場所）

## コマンド

`server/` で実行する。pnpm 12.8.1 を使う。グローバルに無ければ `npx --yes pnpm@12.8.1 <コマンド>` で実行する。

```sh
pnpm install --frozen-lockfile
pnpm lint        # チェックのみ（Biome）
pnpm lint:fix    # 自動修正
pnpm typecheck
pnpm test        # 結合テストは環境変数が無ければスキップされる（下記）
pnpm build
```

変更したら lint / typecheck / test / build が通ることを確認する。

- CouchDB の結合テスト: `COUCHDB_TEST_URL=http://user:pass@localhost:5984` を設定する（`docker run -p 5984:5984 -e COUCHDB_USER=admin -e COUCHDB_PASSWORD=... couchdb:3` で立てられる）
- obsidian-sync-mcp の結合テスト: `OBSIDIAN_MCP_TEST_URL` と `OBSIDIAN_MCP_TEST_TOKEN` を設定する。テスト用の Vault にだけ向けること
- pnpm 12 は `pnpm run <script> -- --opt` の `--` をそのままスクリプトに渡す。スクリプト側で先頭の `--` を読み飛ばしているので、新しい CLI も同じ扱いにする

## 壊しやすい前提

サーバーと Android にまたがる前提（日付、`POST /api/ingest` のマージ、トークンの検査）はルートの AGENTS.md にある。

- ノートの生成は決定的でなければならない（生成日時などを入れない）。同期処理は「内容が変わらないノートは書き込まない」ことに依存している
- 日次ノートの `%% health:memo` の行より下は利用者のメモ欄。`mergeMemo` で必ず保持する。obsidian-sync-mcp の `write_note` はノート全体を置き換えるので、読んでから書く
- Vault への書き込みは `VAULT_HEALTH_PREFIX`（既定 `Health/`）配下の `.md` / `.base` に限る
- 前後の日のリンクは、範囲で探さず `HealthStore.findAdjacentDate` で求める（データが長く途切れていても正しくつなぐため）
- obsidian-sync-mcp は LiveSync 1.0.33 以降の「ID キー」に未対応。LiveSync 側の ID キーや Obfuscate Properties の設定を変える提案をしない（[ADR 0007](../docs/adr/0007-write-via-obsidian-sync-mcp.md)）

## デプロイ

fly.io にデプロイする。手順と秘密情報の登録は [docs/deploy.md](../docs/deploy.md) にある。`fly.toml` のアプリ名はプレースホルダーなので、本番のアプリ名をリポジトリに書かない。
