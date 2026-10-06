# AGENTS.md

このリポジトリで作業するコーディングエージェント向けの指示。全体像は [README.md](README.md)、設計判断の経緯は [docs/adr](docs/adr/README.md) を先に読むこと。PR のレビューで見る観点は [REVIEW.md](REVIEW.md) にまとめている。

## 構成

- `server/` — TypeScript / Hono のサーバー。日次データの受信・保存（CouchDB）、Google Takeout の取り込み、Obsidian ノートの生成と obsidian-sync-mcp 経由の書き込み
  - `src/domain/` 日次・月次のデータ型と集計（純粋関数）
  - `src/store/` 保存先（`HealthStore`。CouchDB 実装とテスト用のメモリ実装）
  - `src/notes/` ノート・ダッシュボード・Bases の生成（純粋関数、出力は決定的）
  - `src/sync/` どのノートを更新するかの計画と実行
  - `src/vault/` obsidian-sync-mcp を MCP クライアントとして呼ぶ書き込み
  - `src/takeout/` Takeout（Google Fit 形式）の解析
  - `src/shared/` 複数の層から使う、健康データを知らない汎用の部品（純粋関数のユーティリティ、汎用の基底クラスなど）。必要になったときに作る
  - `scripts/` `import:takeout` と `sync:notes` の CLI
  - 依存の向き（これ以外の import はしない）:
    - `shared` → なし（他の層を import しない）。どの層からも使ってよい（以下の一覧では省略する）
    - `domain` → なし（外部ライブラリは zod のみ）
    - `notes` / `store` / `takeout` → `domain`
    - `sync` → `domain` / `notes` と、`store` / `vault` のインターフェース（`HealthStore` / `VaultWriter`）
    - `routes` → `domain` / `sync` と、`store` のインターフェース
    - `vault` → なし（設定の `Config` も知らない。必要な値は引数で受け取る）
    - `index.ts` / `app.ts` / `config.ts` / `scripts/` → 何でもよい（設定を読み、実装を組み立てる場所）
- `android/` — Kotlin / Jetpack Compose のアプリ。Health Connect から日次サマリーを作り `POST /api/ingest` へ送る。集計ロジックは Android に依存しない純粋な Kotlin（`DayAggregator`、`SleepAssigner` など）。今は 1 つのパッケージだが、機能ごとにパッケージを分けたら、複数の機能から使う汎用の部品は `shared` パッケージに置く
- `docs/adr/` — 設計判断の記録

## コマンド

サーバー（`server/` で実行。pnpm 12.8.1 を使う。グローバルに無ければ `npx --yes pnpm@12.8.1 <コマンド>`）:

```sh
pnpm install --frozen-lockfile
pnpm lint        # チェックのみ（Biome）
pnpm lint:fix    # 自動修正
pnpm typecheck
pnpm test        # 結合テストは環境変数が無ければスキップされる（下記）
pnpm build
```

- CouchDB の結合テスト: `COUCHDB_TEST_URL=http://user:pass@localhost:5984` を設定する（`docker run -p 5984:5984 -e COUCHDB_USER=admin -e COUCHDB_PASSWORD=... couchdb:3` で立てられる）
- obsidian-sync-mcp の結合テスト: `OBSIDIAN_MCP_TEST_URL` と `OBSIDIAN_MCP_TEST_TOKEN` を設定する。テスト用の Vault にだけ向けること
- pnpm 12 は `pnpm run <script> -- --opt` の `--` をそのままスクリプトに渡す。スクリプト側で先頭の `--` を読み飛ばしているので、新しい CLI も同じ扱いにする

Android（`android/` で実行。JDK 21 が必要。`JAVA_HOME` を JDK 21 にする）:

```sh
./gradlew testDebugUnitTest assembleDebug
```

## 変更するときの約束

- 変更したら、該当するテストを追加・更新し、サーバーは lint / typecheck / test / build、Android は testDebugUnitTest / assembleDebug が通ることを確認してから完了とする
- **個人の情報をリポジトリに入れない**: 実在の健康データの値、本番のホスト名・アプリ名、メールアドレス、トークンやパスワード。テストのデータは架空の値で作る
- **特定の端末やメーカーに依存した処理を書かない**（例: 睡眠の元データは、パッケージ名ではなく「睡眠ステージを持つ記録を優先し、合計時間が長いもの」で選ぶ）。サーバーの Takeout 取り込みと Android アプリで、同じ規則を保つ
- 設計に関わる判断をしたら `docs/adr/` に ADR を追加する。過去の判断を覆すときは元の ADR を書き換えず、新しい ADR を作って元のステータスを「置き換え済み」にする
- 変数は基本 `const`（Kotlin は `val`）で宣言し、再代入しない。値を書き換えて積み上げるより、`map` / `filter` / `reduce` で新しい値を作るか、小さな関数に切り出して返す。例外は Compose の状態（`var x by remember`）、状態機械（CSV の解析など）、ループやリトライの制御そのもので、例外にする箇所には理由をコメントで残す
- 識別子（関数名・変数名・クラス名など）は ASCII の英語で書く。テストの関数名も英語の camelCase にする。日本語の説明はコメントや文字列に書く
- 依存は一方向に保つ。内側（ドメインや純粋な処理）は外側（保存先・Vault・HTTP・設定・CLI）を知らず、同じ層どうしで横断しない。外側の実装はインターフェース越しに使い、組み立ては外側で行う。向きは「構成」の一覧に従い、新しい層を作るときは一覧に書き足す
- 複数の層（Android では複数の機能）から使わざるを得ないもののうち、健康データを知らない汎用のもの（純粋関数のユーティリティ、汎用の基底クラスなど）は `shared` に置く。健康データの型や規則など、このアプリの知識を含むものは `domain` に置く。`shared` は他の層に依存しない。1 つの層でしか使わないものは、その層の中に置いたままにする（先回りして `shared` に移さない）。理由は [ADR 0016](docs/adr/0016-shared-for-cross-layer-utilities.md)
- コードのコメントは日本語で、必要な箇所にだけ書く
- コミットメッセージは Conventional Commits の形式で、接頭辞（`feat:` など）以外は日本語で書く

## 壊しやすい前提

- 日付は Asia/Tokyo の暦日（`YYYY-MM-DD`）。睡眠は起床した日に属する
- `POST /api/ingest` はセクションごとにマージする。**項目を省略すると既存の値が残り、`null` を送ると値を消す**。データが無い項目は `null` ではなく省略して送る
- ノートの生成は決定的でなければならない（生成日時などを入れない）。同期処理は「内容が変わらないノートは書き込まない」ことに依存している
- 日次ノートの `%% health:memo` の行より下は利用者のメモ欄。`mergeMemo` で必ず保持する。obsidian-sync-mcp の `write_note` はノート全体を置き換えるので、読んでから書く
- Vault への書き込みは `VAULT_HEALTH_PREFIX`（既定 `Health/`）配下の `.md` / `.base` に限る
- 前後の日のリンクは、範囲で探さず `HealthStore.findAdjacentDate` で求める（データが長く途切れていても正しくつなぐため）
- obsidian-sync-mcp は LiveSync 1.0.33 以降の「ID キー」に未対応。LiveSync 側の ID キーや Obfuscate Properties の設定を変える提案をしない（[ADR 0007](docs/adr/0007-write-via-obsidian-sync-mcp.md)）
- トークン類は起動時に制御文字を検査している（端末への貼り付けで ESC が混入した実例がある）。検査を緩めない

## デプロイ

- サーバーは fly.io。`server/fly.toml` のアプリ名はプレースホルダーなので、`fly deploy -a <アプリ名> --ha=false` で指定する
- 秘密情報（`API_TOKEN`、`COUCHDB_*`、`OBSIDIAN_MCP_*`）は fly.io の secrets に登録し、リポジトリやログに出さない。案内するときは、シェルの履歴に残らない `fly secrets import -a <アプリ名>` に標準入力から `KEY=value` を渡す方法（入力後に Ctrl-D）を基本とする。`fly secrets set` は値が履歴に残るので、使う場合はその点を添える。エージェントが値を扱う必要がある手順は、利用者自身に実行してもらう
- Android アプリはデバッグ署名の APK を手動でインストールする（`android/README.md`）
