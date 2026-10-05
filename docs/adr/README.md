# Architecture Decision Records

このプロジェクトの設計上の判断と、その経緯を記録する。

| No. | タイトル | ステータス |
|---|---|---|
| [0001](0001-health-connect-as-data-source.md) | 健康データの取得元を Health Connect + 自作 Android アプリにする | 採用 |
| [0002](0002-deploy-to-flyio.md) | サーバーのデプロイ先を Vercel から fly.io に変更する | 採用 |
| [0003](0003-livesync-cli-for-obsidian-writes.md) | Obsidian への書き込みに公式 Self-hosted LiveSync CLI を使う | 置き換え済み（0007） |
| [0004](0004-remote-mcp-with-oauth.md) | Claude との接続をリモート MCP サーバー + OAuth にする | 置き換え済み（0007） |
| [0005](0005-store-health-data-in-couchdb.md) | 健康データを既存 CouchDB の別データベースに保存する | 採用 |
| [0006](0006-server-rendered-notes-from-notion-layout.md) | ノートはサーバーが生成し、Notion のダッシュボード構成を移植する | 採用 |
| [0007](0007-write-via-obsidian-sync-mcp.md) | Vault への書き込みと Claude との接続を obsidian-sync-mcp に任せる | 採用 |
| [0008](0008-android-app-health-connect-mapping.md) | Android アプリの送信方式と Health Connect の項目の対応 | 採用 |
| [0009](0009-protect-daily-note-memo.md) | 日次ノートのメモ欄を消さないよう、不在の判定とマーカーの無いノートの扱いを厳しくする | 採用 |
| [0010](0010-pin-dependencies-and-dependabot.md) | CI・ビルドの依存を固定し、Dependabot で月に一度更新する | 採用（一部を 0014 で更新） |
| [0011](0011-android-release-signing.md) | Android アプリのリリース署名は仕組みだけを用意し、鍵は利用者が管理する | 採用 |
| [0012](0012-input-validation-and-error-exposure.md) | 受信データの上限と、応答に載せるエラー文の範囲を決める | 採用 |
| [0013](0013-merge-split-sleep-sessions.md) | 間隔が 2 時間以内の睡眠セッションを一晩の睡眠に結合する | 採用 |
| [0014](0014-node-24-and-corepack-from-npm.md) | サーバーの Node を 24 にし、corepack は npm で固定版を入れる | 採用 |

## 書き方

新しい判断をしたら [template.md](template.md) をコピーして連番で追加し、上の表に1行足す。
過去の判断を覆すときは元の ADR を書き換えず、ステータスを「置き換え済み（00XX）」にして新しい ADR を作る。
