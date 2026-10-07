# AGENTS.md

このリポジトリで作業するコーディングエージェント向けの指示。全体像は [README.md](README.md)、設計判断の経緯は [docs/adr](docs/adr/README.md) を先に読むこと。PR のレビューで見る観点は [REVIEW.md](REVIEW.md) にまとめている。

## 構成

- `server/` — TypeScript / Hono のサーバー。日次データの受信・保存（CouchDB）、Google Takeout の取り込み、Obsidian ノートの生成と obsidian-sync-mcp 経由の書き込み、暗号化したバックアップの提供と復元
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
  - 依存の向き（これ以外の import はしない）:
    - `shared` → なし（他の層を import しない）。どの層からも使ってよい（以下の一覧では省略する）
    - `domain` → なし（外部ライブラリは zod のみ）
    - `notes` / `store` / `takeout` / `backup` → `domain`
    - `sync` → `domain` / `notes` と、`store` / `vault` のインターフェース（`HealthStore` / `VaultWriter`）
    - `routes` → `domain` / `sync` / `backup` と、`store` のインターフェース
    - `vault` → なし（設定の `Config` も知らない。必要な値は引数で受け取る）
    - `index.ts` / `app.ts` / `config.ts` / `scripts/` → 何でもよい（設定を読み、実装を組み立てる場所）
- `android/` — Kotlin / Jetpack Compose のアプリ。Health Connect から日次サマリーを作り `POST /api/ingest` へ送る。集計ロジックは Android に依存しない純粋な Kotlin（`DayAggregator`、`SleepAssigner` など）。今は 1 つのパッケージだが、機能ごとにパッケージを分けたら、複数の機能から使う汎用の部品は `shared` パッケージに置く
- `gas/` — Google Apps Script。サーバーのバックアップを Google Drive に保存する（GAS のエディタに手でコピーして使う。[docs/backup.md](docs/backup.md)）
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
  - `shared` のファイルは中身を表す名前にする（例: `shared/concurrency.ts` に `mapLimit`）。`utils` / `helpers` / `common` / `misc` / `lib` のような名前は使わない。名詞 1 つで名前を付けられないものは、`shared` に向いていない
  - 1 ファイル 1 テーマにし、テーマが違うものは別のファイルにする。`shared/index.ts` のような再エクスポートだけのファイル（バレル）は作らない
  - 使う層が 1 つに減ったら、その層へ戻す
  - `shared` を初めて作るときに、禁止した名前のファイルが無いことと、`shared` から他の層を import していないことを確かめる vitest のテストも足す（新しい依存は入れない）
- 設計の原則（DRY・KISS・YAGNI・単一責任・マジックナンバーの定数化）は、次の線の引き方で使う。原則どうしがぶつかったときに迷わないためで、理由は [ADR 0017](docs/adr/0017-design-principles.md)
  - **DRY**: 規則・定数・形式など「同じ知識」の重複は、2 か所目でまとめる。処理の形が似ているだけの重複は、3 か所目でまとめるのを基本にする。見た目が似ていても変わる理由が違うコードは重複とみなさない
  - **KISS**: DRY とぶつかったら読みやすさを優先する。まとめた結果、呼び出し側で分岐や引数が増えるならまとめない。抽象化（インターフェース、基底クラス、ラッパー）は、実装が 2 つ以上あるか、テストで差し替えるなどの理由があるときだけ作る
  - **YAGNI**: 今の要件に無い機能・引数・設定項目・拡張点を「将来使うかも」で足さない
  - サーバー（TypeScript）と Android（Kotlin）にまたがる同じ規則は 1 か所にまとめられない。同じ規則であることをコメントで示し、同じ入力に対するテストを両方に置く
  - **単一責任**: 1 つの関数・クラスに、変わる理由の違う複数のことをさせない（例: 計算と I/O を混ぜない）
  - **マジックナンバーを定数にする**: 意味のある数値（日数、リトライの間隔や回数、上限など）は、名前を付けた定数にする
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

## セキュリティ

扱うのは個人の健康データで、サーバーはインターネットに公開している。レビューで確認することは REVIEW.md の「セキュリティ（脆弱性）」にある。

- 経路は認証の掛かったグループに置く。`/api/*` は `API_TOKEN`、`/backup/*` は `BACKUP_TOKEN` で、互いの経路を使えないよう分けている（バックアップ用のトークンが漏れても書き込めず、書き込み用のトークンでは全データを取れないようにするため）。認証なしの経路はデータや設定を返さない
- 設定が足りないときは、認証を外して動かさず、経路を作らないか起動を止める
- 外から来る値（リクエスト、Takeout、復元するバックアップ、Vault から読んだノート、外部サービスの応答）は zod などで検証してから使う。件数・サイズ・期間には上限を設ける
- ノートやクエリに埋め込む値はエスケープする。YAML は `notes/yaml.ts` を使い、Vault のパスは `assertVaultPath` を通す
- トークンを送る先は `https:` に限る（試験用の `http://localhost` を除く）。外部への通信にはタイムアウトを付ける
- 応答にスタックトレースや内部のエラー文を含めない。ログに健康データの中身を出さない
- バックアップの秘密鍵はサーバーに置かない。暗号化前のデータをディスクに残さない

## デプロイ

- サーバーは fly.io。`server/fly.toml` のアプリ名はプレースホルダーなので、`fly deploy -a <アプリ名> --ha=false` で指定する
- 秘密情報（`API_TOKEN`、`COUCHDB_*`、`OBSIDIAN_MCP_*`）は fly.io の secrets に登録し、リポジトリやログに出さない。案内するときは、シェルの履歴に残らない `fly secrets import -a <アプリ名>` に標準入力から `KEY=value` を渡す方法を基本とする。案内では、`KEY=` と打ってから値だけを貼る形で 1 行ずつ入力し、最後に Enter で空の行に移ってから Ctrl-D（終わらなければもう一度）と書く。置き換える値は `<…>` で書き、`<` `>` も含めて置き換えると添える。`fly secrets set` は値が履歴に残るので、使う場合はその点を添える。エージェントが値を扱う必要がある手順は、利用者自身に実行してもらう
- Android アプリはデバッグ署名の APK を手動でインストールする（`android/README.md`）
