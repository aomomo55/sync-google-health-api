# 0002: サーバーのデプロイ先を Vercel から fly.io に変更する

- ステータス: 採用
- 日付: 2026-10-03

## 背景

当初は Vercel の Serverless Function に API を置き、Google の認証情報を Vercel の環境変数に入れる想定だった。

その後、次のことが決まった。

- Obsidian への書き込みには、公式の Self-hosted LiveSync CLI を使う（[0003](0003-livesync-cli-for-obsidian-writes.md)）。この CLI は手元に PouchDB（ローカルのデータベース）を持ち、それを CouchDB と同期する仕組みなので、ファイルを保存し続けられる環境が必要
- 利用者は Obsidian の同期用 CouchDB をすでに fly.io で運用している

## 決定

サーバー（Hono の API、MCP エンドポイント、LiveSync CLI）を fly.io の 1 つのアプリにまとめ、永続ボリュームを付ける。Vercel は使わない。

## 検討した選択肢

| 選択肢 | 長所 | 短所 |
|---|---|---|
| Vercel のみ | デプロイが簡単 | ファイルを保存し続けられず、LiveSync CLI が動かない。E2EE を自前で実装する必要がある |
| Vercel + fly.io（書き込みだけ分離） | API は Vercel のまま | 管理するサービスとデプロイ先が 2 つになる |
| **fly.io に一本化** | LiveSync CLI がそのまま動く。既存の CouchDB と同じ基盤で管理できる | Docker イメージとボリュームの管理が必要 |

## 結果

- Upstash Redis も不要になった（[0005](0005-store-health-data-in-couchdb.md)）
- Dockerfile と fly.toml の管理、ボリュームのバックアップを引き受ける
- 秘密情報（API トークン、CouchDB の認証情報、LiveSync のパスフレーズ）は fly.io の secrets で管理する
