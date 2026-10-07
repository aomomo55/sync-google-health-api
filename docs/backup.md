# 健康データのバックアップと復元

CouchDB の `health` DB（日次データ）を、1 日 1 回 Google Drive にバックアップする。決めた理由は [ADR 0015](adr/0015-backup-health-db-to-google-drive.md)。

## しくみ

```
GAS（毎日 4 時台）──GET /backup/health（BACKUP_TOKEN）──▶ サーバー
                                                          │ health DB の全期間を JSON → gzip → age で暗号化
GAS ◀──────────── health-YYYY-MM-DD.json.gz.age ──────────┘
 │
 └─▶ Google Drive のフォルダに保存
       日次: health-YYYY-MM-DD.json.gz.age        最新 7 世代
       週次: health-weekly-YYYY-MM-DD.json.gz.age 日曜の分を最新 5 世代（約 1 か月）
```

- 暗号化は age の公開鍵で行う。秘密鍵は手元だけに置くので、サーバー・GAS・Google Drive のどこから漏れても中身は読めない
- `BACKUP_TOKEN` はバックアップの取得にだけ使える。`/api`（データの書き込み）には使えない
- 前回より日数が減ったときは、古い世代を消さずに残し、メールで知らせる（誤ってデータを消したときに、正常なバックアップまで入れ替わって消えるのを防ぐ）
- 失敗したときは、GAS を動かしている Google アカウントにメールが届く

## 初回の設定

### 1. 鍵の組を作る（手元で）

[age](https://github.com/FiloSottile/age) を入れ、鍵の組を作る。

```sh
age-keygen -o health-backup-key.txt
```

- 表示される `Public key: age1…` のうち、`Public key: ` より後ろの `age1…` 全体が公開鍵（`age1` も含めて 62 文字。サーバーに登録する）。`health-backup-key.txt` の `# public key:` の行にも同じものがある
- `health-backup-key.txt` が秘密鍵。**サーバーやリポジトリ、Google Drive には置かない**。パスワードマネージャーなど、手元の安全な場所に保管する。失くすとバックアップを復号できない

### 2. サーバーに登録する

`BACKUP_TOKEN` を作る（`API_TOKEN` とは別の値にする）。

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

fly.io の secrets に登録する。シェルの履歴に残らないよう、標準入力から渡す。`<…>` は自分の値に置き換える部分。

```sh
fly secrets import -a <アプリ名>
BACKUP_TOKEN=<作ったトークン>
BACKUP_AGE_RECIPIENT=<公開鍵（age1 も含めた 62 文字）>
```

- 1 行目を実行すると入力待ちになるので、2・3 行目を貼り付ける
- 貼り付けたあと **Enter を押してカーソルを空の行に移してから Ctrl-D** を押す。最後の行に改行が無いまま Ctrl-D を押すと、その行が確定するだけで、入力待ちのまま終わらない
- `BACKUP_AGE_RECIPIENT` には公開鍵だけを入れる。`Public key:` などの前置きや、秘密鍵（`AGE-SECRET-KEY-…`）を入れると、サーバーが起動しなくなる（[うまくいかないとき](#うまくいかないとき)）

登録するとサーバーが再起動する。`BACKUP_TOKEN` と `BACKUP_AGE_RECIPIENT` は両方そろって初めて `/backup/health` が有効になる（片方だけだと起動時にエラー）。

### 3. Google Drive のフォルダを作る

保存先のフォルダを作り、URL の `https://drive.google.com/drive/folders/<ここ>` の部分（フォルダ ID）を控える。

### 4. GAS を設定する

1. https://script.google.com で新しいプロジェクトを作る
2. 「プロジェクトの設定」で「appsscript.json マニフェスト ファイルをエディタで表示する」をオンにし、[`gas/appsscript.json`](../gas/appsscript.json) の内容で置き換える
3. `コード.gs` を [`gas/backup.gs`](../gas/backup.gs) の内容で置き換える
4. 「プロジェクトの設定」→「スクリプト プロパティ」に次を追加する
   - `BACKUP_URL`: `https://<アプリ名>.fly.dev/backup/health`
   - `BACKUP_TOKEN`: 2 で作ったトークン
   - `FOLDER_ID`: 3 のフォルダ ID
5. エディタで `runBackup` を一度実行し、権限を許可する。フォルダに `health-YYYY-MM-DD.json.gz.age` ができることを確かめる
6. `install` を一度実行する（毎日 4 時台に `runBackup` を実行するトリガーができる）

### 5. 復元を一度試す

下の「復元」の手順で、作ったバックアップを空の DB に戻し、中身を確かめる。

## 手動でバックアップを取る

大量に書き込む作業（Takeout の取り込み直しなど）の前は、GAS のエディタで `runBackup` を実行する。同じ日のファイルは置き換わる。

## 復元

本番の DB には直接書かず、**空の別の DB に戻して確かめてから入れ替える**。

### 1. 中身を確かめる（書き込まない）

Google Drive からファイルを取ってきて、`server/` で実行する。

```sh
pnpm restore:backup -- --file health-2026-10-06.json.gz.age --identity health-backup-key.txt --dry-run
```

作成日時、日数、期間が表示される。形が不正な日があれば一覧が出る（その日は除いて復元される）。

### 2. 空の DB に書き戻す

CouchDB の接続情報を環境変数に入れて実行する。`--db` には、まだ存在しないか空の DB の名前を指定する（文書が 1 件でもあれば、別用途の DB を指定した場合も含めて、書き込まずに止まる）。

```sh
COUCHDB_URL=https://... COUCHDB_USER=... COUCHDB_PASSWORD=... \
  pnpm restore:backup -- --file health-2026-10-06.json.gz.age --identity health-backup-key.txt --db health_restore_20261006
```

パスワードがシェルの履歴に残らないよう、環境変数は `.env` ファイルなどから読み込むとよい。

### 3. 確かめてから入れ替える

1. 書き戻した DB の件数と期間を確かめる（CouchDB の管理画面、または `--dry-run` の表示と比べる）
2. サーバーの `COUCHDB_HEALTH_DB` を書き戻した DB の名前に切り替える（`fly secrets import` で登録。サーバーが再起動する）
3. `sync:notes` でノートを作り直し、内容を確かめる
4. 問題なければ、古い DB は一定期間残してから削除する

## うまくいかないとき

### secrets を登録したら、サーバーが応答しなくなった（502）

起動時の設定の検査で止まり、再起動を繰り返している。`fly logs -a <アプリ名>` に `環境変数が不正です` と、どの値が不正かが出る。

- `BACKUP_AGE_RECIPIENT: age の公開鍵（age1...）を指定してください`: 公開鍵の値が違う。前置きが付いている、途中で切れている、秘密鍵を入れた、などを確かめ、正しい公開鍵だけを `fly secrets import` で登録し直す
- `BACKUP_TOKEN: …`: トークンが短い、使えない文字を含む、`API_TOKEN` と同じ、のどれか

正しい値を登録すれば、サーバーは自動で再起動して戻る。

### GAS の実行が `サーバーが HTTP 401 を返しました` で失敗する

GAS のスクリプト プロパティの `BACKUP_TOKEN` が、サーバーに登録した値と一致していない。

- プロパティの値の前後に空白や改行が入っていないか確かめる（GAS は前後の空白を取り除かない）
- トークンを作るコマンドを 2 回実行して、別の値をそれぞれに登録していないか確かめる
- 分からなければ、新しいトークンを作り、サーバー（`fly secrets import`）と GAS の両方に同じ値を登録し直す

## 確認済みのこと

- バックアップ → 復号 → 空の DB への書き戻しで、元の DB と中身が一致する（CouchDB 3 で確認）
- 違う秘密鍵では復号できない。データのある DB には書き戻さない
