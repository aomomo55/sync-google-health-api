# 0019: COUCHDB_URL を https に限り、http は localhost と fly.io のプライベートネットワークだけ許す

- ステータス: 採用
- 日付: 2026-10-07

## 背景

GitHub issue #46 で、CouchDB への接続先の検査に次の弱点が見つかった。

- `COUCHDB_URL` は `http:` / `https:` のどちらでも、どのホストでも受け付けていた。CouchDB には Basic 認証で `COUCHDB_USER` / `COUCHDB_PASSWORD` を毎回送るので、`http:` で外部のホストを指定すると、資格情報と健康データが平文でネットワークを流れる
- 復元の CLI（`scripts/restore-backup.ts`）は環境変数をそのまま使い、サーバーの設定（`src/config.ts`）の検査（URL のスキーム、URL に資格情報を含めない、制御文字を含めない）を通していなかった

一方、CouchDB を同じ fly.io の組織に置き、プライベートネットワーク（`<アプリ名>.internal` や `<アプリ名>.flycast`）経由で `http:` でつなぐ構成がある。この通信は fly.io の WireGuard の中だけを通り、インターネットには出ない。

`OBSIDIAN_MCP_URL` は既に `https:` に限り、ローカルでの試験用に `localhost` / `127.0.0.1` / `[::1]` だけ `http:` を許している。

## 決定

- `COUCHDB_URL` は `https:` に限る。`http:` は次のホストだけ許す
  - `localhost` / `127.0.0.1` / `[::1]`（ローカルでの試験用。`OBSIDIAN_MCP_URL` と同じ）
  - ホスト名が `.internal` または `.flycast` で終わるもの（fly.io のプライベートネットワーク）
- 「`https:` か、許したホストへの `http:` か」の判定は `src/config.ts` の 1 か所に置き、`COUCHDB_URL` と `OBSIDIAN_MCP_URL` で共有する。どのホストに `http:` を許すかだけを、それぞれで渡す。`OBSIDIAN_MCP_URL` の許す範囲は広げない（トークンを送る先は `https:` に限る、の線を保つ）
- URL にユーザー名・パスワードを含めたら拒否する規則は、そのまま残す
- 復元の CLI は、`src/config.ts` の `loadCouchdbConnection` で `COUCHDB_URL` / `COUCHDB_USER` / `COUCHDB_PASSWORD` をサーバーと同じ規則で検査する。失敗したら、値を出さずにどの環境変数がなぜ不正かだけを表示して止まる

## 検討した選択肢

| 選択肢 | 長所 | 短所 |
|---|---|---|
| `https:` と、localhost・fly.io のプライベートネットワークへの `http:` を許す（採用） | 外部のホストへ平文で資格情報を送る設定を起動時に止められる。プライベートネットワークでつなぐ構成をそのまま使える | ホスト名の末尾で判定するので、`.internal` / `.flycast` を独自に名前解決する環境では、外へ出る通信も通してしまう |
| `https:` だけを許す（localhost も不可） | 規則が最も単純 | プライベートネットワークでつなぐ構成が動かなくなる。ローカルの CouchDB で試せなくなる |
| `https:` と localhost だけを許す | `OBSIDIAN_MCP_URL` と同じ規則にそろう | プライベートネットワークでつなぐ構成が動かなくなる（CouchDB に TLS を用意する必要が出る） |
| `http:` をどのホストでも許す（従来どおり） | 設定の自由度が高い | `http:` の指定ひとつで、パスワードと健康データが平文でインターネットを流れる |

## 結果

- 外部のホストへの `http:` を指定していた場合は、起動時と復元の CLI で止まるようになる。`https:` に直すか、fly.io のプライベートネットワークのホスト名に変える必要がある
- サーバーと復元の CLI で、CouchDB の接続情報の検査が 1 か所にそろう
- fly.io 以外のプライベートネットワーク（VPN や同じホストの別コンテナなど）で `http:` を使う構成は受け付けない。必要になったら、許すホストの規則を見直す

## 参考

- fly.io のプライベートネットワーク: https://fly.io/docs/networking/private-networking/
- GitHub issue #46
