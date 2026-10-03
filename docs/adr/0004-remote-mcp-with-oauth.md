# 0004: Claude との接続をリモート MCP サーバー + OAuth にする

- ステータス: 置き換え済み（[0007](0007-write-via-obsidian-sync-mcp.md)）
- 日付: 2026-10-03

## 背景

当初は「Claude Cowork に固定の Bearer Token を渡し、Claude が GET で API を叩く」想定だった。
その後、利用者は Claude を主にスマホアプリから使うと分かった。スマホの Claude アプリが外部のサーバーを使うには、claude.ai に登録したカスタムコネクタ（リモート MCP サーバー）を経由する必要がある。

カスタムコネクタが対応している認証方式は次のとおり。

| 方式 | 状況 |
|---|---|
| OAuth 2.0（Dynamic Client Registration / Client ID Metadata Document） | 標準で使える。スマホアプリも対応 |
| 固定の Bearer Token（Request headers） | ベータで一部の組織のみ。利用者の画面には「名前」と「URL」の欄しかなく、使えなかった |
| 認証なし | 使えるが、URL を知っていれば誰でも健康データを読めてしまう |

## 決定

サーバーにリモート MCP エンドポイント（`/mcp`）を設け、一人で使う前提の最小限の OAuth を実装する。

- 401 応答に `WWW-Authenticate: Bearer resource_metadata=...` を付け、Protected Resource Metadata（RFC 9728）と Authorization Server Metadata（RFC 8414）を返す
- クライアント登録は DCR か CIMD、PKCE（S256）必須、リダイレクト先は `https://claude.ai/api/mcp/auth_callback`
- 同意ページでは、利用者だけが知るパスワードを入力したときだけトークンを発行する
- 補助的に、Claude のアクセス元 IP（`160.79.104.0/21`）での制限も検討する
- Android アプリからの `POST /api/ingest` は、従来どおり固定の Bearer Token で認証する

## 検討した選択肢

| 選択肢 | 長所 | 短所 |
|---|---|---|
| 固定の Bearer Token | 実装が最も簡単 | 利用者の環境ではコネクタに設定できない |
| 認証なし + 推測困難な URL | 実装が簡単 | URL が漏れると健康データが読まれる。トークンを URL に入れるのは MCP の仕様でも禁止されている |
| **OAuth（自前の最小実装）** | スマホアプリを含む全 Claude 製品で使える | 認可サーバー部分の実装とテストが必要 |

## 結果

- 認可コードやトークンの保存先が必要になる（CouchDB に保存する予定）
- リフレッシュトークンのローテーション、`invalid_grant` の返却、トークンエンドポイントの応答時間（10 秒以内）など、Claude 側の要件を満たす必要がある

## 参考

- https://claude.com/docs/connectors/building/authentication
