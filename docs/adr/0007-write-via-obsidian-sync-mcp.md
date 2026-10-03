# 0007: Vault への書き込みと Claude との接続を obsidian-sync-mcp に任せる

- ステータス: 採用（[0003](0003-livesync-cli-for-obsidian-writes.md) と [0004](0004-remote-mcp-with-oauth.md) を置き換える）
- 日付: 2026-10-03

## 背景

0003 では公式 LiveSync CLI で Vault に書き込み、0004 では自前の MCP サーバーと OAuth で Claude とつなぐ予定だった。

その後、利用者が **obsidian-sync-mcp**（https://github.com/es617/obsidian-sync-mcp、v0.7.1）を fly.io に「MCP のみ」構成でデプロイし、claude.ai のカスタムコネクタにつないだ。これは次の性質を持つ。

- LiveSync 作者の公式ライブラリ `livesync-commonlib` で CouchDB を直接読み書きし、E2EE に対応する
- パスワード付きの OAuth 2.1 を内蔵し、Claude 以外からは `Authorization: Bearer <MCP_AUTH_TOKEN>` でも呼べる
- `write_note` / `edit_note` / `read_note` / `list_notes` などのツールを持ち、`WRITE_FOLDERS` で書き込めるフォルダを制限できる

LiveSync 1.0.33 から、チャンク ID などを作る「ID キー」が E2EE のパスフレーズから独立した。obsidian-sync-mcp が使う commonlib（2026-08-01 版）はこの仕組みを知らない。
本番の Vault では、Obfuscate Properties を有効にした状態だと `read_note` が常に「Note not found」になり、MCP が書いたノートに LiveSync が「The remote document IDs do not match the configured ID key.」と警告した。
**ID キーをパスフレーズ由来にし、Obfuscate Properties と Encrypt internal file Properties をオフにしてリモートを作り直した**ところ、読み・書き・追記・削除と各端末への同期が正常に動いた。

手元のテスト環境（CouchDB 3.5.2、LiveSync プラグイン 1.0.34、E2EE 有効、難読化なし）でも、次を確認した。

- MCP の `write_note` で書いたノート（日本語・絵文字・frontmatter・60 行、11 チャンクに分割）が Obsidian に警告なしで表示される
- Obsidian で追記した内容を MCP の `read_note` で読める
- `WRITE_FOLDERS=Health` のとき `Health/` 以外への書き込みは拒否される
- `.base` ファイルも書き込める

## 決定

- 自前のサーバーは、健康データの受け取り・保存・ノートの生成だけを担う
- 生成したノートは、obsidian-sync-mcp の `write_note` を Bearer トークンで呼んで Vault に書き込む
- Claude（スマホアプリ）は、接続済みの obsidian-sync-mcp のコネクタで `Health/` のノートを読み、分析する。自前の MCP サーバーと OAuth は作らない
- 自前サーバーから CouchDB と obsidian-sync-mcp へは、公開 URL（HTTPS + 認証）で接続する
  - 当初はプライベートネットワーク（`.internal`）を予定していたが、obsidian-sync-mcp は使われていないと自動停止し、`.internal` 宛ての通信では起動しないため変更した（2026-10-03 追記）

## 検討した選択肢

| 選択肢 | 長所 | 短所 |
|---|---|---|
| 公式 LiveSync CLI（0003）+ 自前 MCP・OAuth（0004） | 公式実装で ID キーにも追従できる | 永続ボリューム、CLI の運用、OAuth の実装が必要 |
| **obsidian-sync-mcp に任せる** | Claude との接続はすでに動いている。自前サーバーが小さくなる | ID キーに未対応のため、本番の LiveSync 設定（パスフレーズ由来の ID キー、難読化オフ）を固定する必要がある |
| `livesync-commonlib` を自前サーバーに直接組み込む | 依存するサービスが減る | obsidian-sync-mcp と同じ ID キーの問題を自分で抱える |

## 結果

- 自前の MCP エンドポイント、OAuth、LiveSync CLI、永続ボリュームが不要になった
- [0002](0002-deploy-to-flyio.md) の fly.io を選んだ理由（CLI のための永続ボリューム）はなくなったが、既存の CouchDB と obsidian-sync-mcp にプライベートネットワークで接続できるので、fly.io を使い続ける
- **本番の LiveSync で ID キーをランダムに戻したり、Obfuscate Properties を有効にしたりすると、obsidian-sync-mcp 経由の読み書きが壊れる。** obsidian-sync-mcp が ID キーに対応するまで、この設定を変えない
- `write_note` はノート全体を置き換えるため、日次ノートに利用者が書いたメモを残すには、読み出してから自動生成部分だけを差し替える必要がある
- 同じノートを Obsidian と同時に編集すると後勝ちになる（obsidian-sync-mcp の既知の制限）

## 参考

- https://github.com/es617/obsidian-sync-mcp
- https://github.com/vrtmrz/obsidian-livesync/releases/tag/1.0.33
- https://github.com/vrtmrz/obsidian-livesync/pull/1225
- https://github.com/vrtmrz/livesync-commonlib/pull/156
