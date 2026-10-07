# sync-google-health-api

[![CI](https://github.com/aomomo55/sync-google-health-api/actions/workflows/ci.yml/badge.svg)](https://github.com/aomomo55/sync-google-health-api/actions/workflows/ci.yml)

Android の Health Connect に集まる健康データ（歩数・心拍・睡眠・体重など）を毎日自動で集め、Obsidian の Vault にダッシュボード付きのノートとして書き込むパイプラインです。
スマホの Claude アプリから、そのノートを読んで健康状態を振り返れるようにすることを目的にしています。

## 全体像

```mermaid
flowchart LR
    W[スマートウォッチ] --> HC[Health Connect]
    HC --> A["Android アプリ<br/>（6 時間ごとに直近 7 日分を送信）"]
    T[Google Takeout<br/>（過去データ）] --> S
    A -- "POST /api/ingest<br/>Bearer 認証" --> S["サーバー（Hono / fly.io）"]
    S --> DB[(CouchDB<br/>health DB)]
    S -- "write_note<br/>（MCP over HTTP）" --> M[obsidian-sync-mcp]
    M --> V[(Self-hosted LiveSync<br/>の CouchDB / E2EE)]
    V --> O[Obsidian<br/>PC・スマホ]
    C[スマホの Claude] -- カスタムコネクタ --> M
```

- **Android アプリ**が Health Connect から日ごとのサマリーを作り、サーバーへ送る
- **サーバー**がデータを保存し、日次・月次ノートとダッシュボードを生成して、[obsidian-sync-mcp](https://github.com/es617/obsidian-sync-mcp) 経由で Vault に書き込む（LiveSync の E2EE を保ったまま全端末に同期される）
- **Claude** は obsidian-sync-mcp のコネクタでノートを読み、分析する

## 主な機能

- 日次ノート: 歩数・距離・消費カロリー・心拍・体重・睡眠（就寝/起床時刻、深い・浅い・REM の内訳、仮眠）をプロパティとして持つ。利用者が書いたメモ欄は自動更新で消えない
- 月次ノートと、Dataview + Charts のグラフ・Bases の表を使ったヘルスケア/睡眠ダッシュボード
- Google Takeout（Google Fit 形式）からの過去データの一括取り込み
- 受信したデータの日と、その前後の日・月のノートだけを更新し、内容が変わらないノートは書き込まない（何度送り直しても結果が同じ）

## 技術スタック

| 部分 | 技術 |
|---|---|
| サーバー | TypeScript, Hono, Node.js 24, zod, Vitest, MCP TypeScript SDK |
| データ保存 | CouchDB |
| Android アプリ | Kotlin, Jetpack Compose, Health Connect, WorkManager, OkHttp, kotlinx.serialization |
| インフラ | fly.io（Docker、自動停止・自動起動） |
| ノート | Obsidian（Self-hosted LiveSync, Dataview, Charts, Bases） |

## リポジトリ構成

```
server/   サーバー、Takeout 取り込み・ノート同期のスクリプト（→ server/README.md）
android/  Health Connect のデータを送る Android アプリ（→ android/README.md）
docs/adr/ 設計判断の記録（Architecture Decision Records）
```

## 設計で考えたこと

経緯は [docs/adr](docs/adr/README.md) に残しています。主なものは次のとおりです。

- **データの取得元**（[0001](docs/adr/0001-health-connect-as-data-source.md)）: Google Health API は新規プロジェクトの受付を停止しており、Fitbit Web API・Google Fit REST API も使えなかったため、端末内の Health Connect から自作アプリで送る方式にした
- **Vault への書き込み**（[0003](docs/adr/0003-livesync-cli-for-obsidian-writes.md) → [0007](docs/adr/0007-write-via-obsidian-sync-mcp.md)）: LiveSync の E2EE 形式を自前で実装すると Vault を壊すおそれがあるため、公式実装を使う方針で検討し、最終的に公式ライブラリを使う obsidian-sync-mcp に任せた。テスト用の Vault で書き込み・逆方向の同期・書き込み先の制限を検証してから採用した
- **ノートの生成**（[0006](docs/adr/0006-server-rendered-notes-from-notion-layout.md)）: Claude に Markdown を書かせると形式がぶれるため、サーバーが決まった形式で生成する
- **秘密情報の扱い**: トークンや認証情報は fly.io の secrets と Android Keystore に置き、ログやエラーメッセージに出さない。端末への貼り付けで紛れ込む制御文字は起動時に検出して止める

## 使い方の流れ

1. CouchDB と obsidian-sync-mcp を用意する（Self-hosted LiveSync を使っている前提）
2. `server/` を fly.io にデプロイし、秘密情報を登録する（[server/README.md](server/README.md)）
   - `fly secrets import -a <アプリ名>` を実行して `KEY=value` を 1 行ずつ入力し、最後に Enter で空の行に移ってから Ctrl-D で終える。値がシェルの履歴に残らない。リポジトリの外に置いた一時ファイル（例: `~/tmp/secrets.env`）から `fly secrets import -a <アプリ名> < ~/tmp/secrets.env` で読み込み、登録後にファイルを消してもよい（ファイル名の前の `<` は入力の切り替えなので、そのまま打つ）
   - `fly secrets set KEY=value -a <アプリ名>` でも登録できるが、値がシェルの履歴に残る
3. 過去データがあれば Google Takeout から取り込み、`sync:notes` でノートとダッシュボードを書き込む
4. `android/` のアプリをビルドして端末に入れ、サーバーの URL と API トークンを設定する（[android/README.md](android/README.md)）

## 動作確認した環境

| 種類 | 環境 |
|---|---|
| スマートフォン | Nothing Phone (3a)（Android 16） |
| スマートウォッチ | CMF Watch Pro 2 |
| Obsidian プラグイン | Self-hosted LiveSync 1.0.34、Dataview、Charts |
| Vault への書き込み | obsidian-sync-mcp 0.7.1 |
| サーバー | Node.js 24（fly.io）、CouchDB 3 |

スマートウォッチのデータは、メーカーの公式アプリから Health Connect に書き込まれたもの（睡眠ステージ付き）で確認しています。端末やアプリによって Health Connect に書き込まれる項目は異なります。

## 制約

- obsidian-sync-mcp が LiveSync 1.0.33 以降の「ID キー」に対応するまで、LiveSync 側は ID キーをパスフレーズ由来にし、Obfuscate Properties を無効にしておく必要がある（[0007](docs/adr/0007-write-via-obsidian-sync-mcp.md)）
- Health Connect には Google Fit の Move Minutes やハートポイントに当たる項目がないため、運動時間はエクササイズの記録時間で近似している（[0008](docs/adr/0008-android-app-health-connect-mapping.md)）
- 個人用途（利用者 1 人）を前提にしている

## ライセンス

[MIT](LICENSE)
