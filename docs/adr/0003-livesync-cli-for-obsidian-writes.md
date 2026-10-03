# 0003: Obsidian への書き込みに公式 Self-hosted LiveSync CLI を使う

- ステータス: 置き換え済み（[0007](0007-write-via-obsidian-sync-mcp.md)）
- 日付: 2026-10-03

## 背景

利用者は Claude をスマホアプリから使うため、Claude が PC のファイル（Vault）を直接読み書きすることはできない。
Obsidian の Vault は Self-hosted LiveSync プラグインで fly.io 上の CouchDB に同期されており、End-to-End Encryption（パスフレーズによる暗号化）が有効になっている。
サーバーから CouchDB に書き込めば全端末に同期されるが、LiveSync はファイルをそのままではなく、メタデータとチャンクに分割し、暗号化して保存している。

調査の結果、次のことが分かった。

- 形式の公式な説明（`docs/datastructure.md`）はあるが、ハッシュ方式やチャンク分割の方式はバージョンによって変わってきている（1.0.0-rc も出ている）
- 暗号化の方式や、パスの難読化の計算方法は公式ドキュメントでは確認しきれず、ライブラリのソースを読む必要がある
- LiveSync の公式リポジトリに、Node.js で動く公式 CLI（`src/apps/cli`）がある。E2EE に対応し、`put` / `cat` / `ls` / `sync` などのコマンドを持つ。手元に PouchDB を持ち、CouchDB と同期する仕組み

## 決定

CouchDB の形式や暗号化を自前で実装せず、公式 CLI で書き込む。

- 書き込みは Vault の `Health/` 配下に限定する
- 本番の Vault に書き込む前に、CouchDB のバックアップを取り、テスト用のデータベースで「1 件書き込み、Obsidian で正しく同期・復号される」ことを確認する

## 検討した選択肢

| 選択肢 | 長所 | 短所 |
|---|---|---|
| 形式と暗号化を自前で実装（Vercel で `fetch` のみ） | サーバーレスで動く | 形式の変化に追従できず、Vault を壊す危険が大きい |
| `livesync-commonlib` を直接使う | 公式の実装を流用できる | PouchDB やブラウザ向けの依存が大きく、どこまで必要か読み解く必要がある |
| livesync-bridge（Deno） | E2EE・難読化に対応 | 常駐プロセスとファイル同期が前提で、今回の用途には大きすぎる |
| **公式 CLI** | 公式実装なので形式の変化に CLI の更新で追従できる | ファイルを保存し続けられる環境が必要（→ [0002](0002-deploy-to-flyio.md)） |

## 結果

- サーバーは fly.io の永続ボリューム上で CLI 用のローカル DB を持つ
- サーバーに LiveSync のパスフレーズを持たせることになる（fly.io の secrets で管理）
- CLI のバージョンと、利用者の Obsidian プラグインのバージョンを揃えて管理する必要がある

## 参考

- https://github.com/vrtmrz/obsidian-livesync/tree/main/src/apps/cli
- https://github.com/vrtmrz/obsidian-livesync/blob/main/docs/datastructure.md
