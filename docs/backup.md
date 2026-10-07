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

## この文書の書き方

- `<…>` は自分の値に置き換える部分。`<` と `>` も含めて置き換える（記号が残ると、サーバーの起動時の検査に通らない）
- 鍵やバックアップのファイルは、**リポジトリの外**（ホームのフォルダなど）に置く。例のパスもリポジトリの外にしている
- コマンドは、特に断りが無ければ bash の書き方。`fly` を WSL で、Node を Windows の PowerShell で使っている場合は、各手順の注記に従う

## 初回の設定

### 1. 鍵の組を作る（手元で）

[age](https://github.com/FiloSottile/age) を入れ、ホームのフォルダで鍵の組を作る。

```sh
cd ~
age-keygen -o health-backup-key.txt
```

- 表示される `Public key: age1…` のうち、`Public key: ` より後ろの `age1…` 全体が公開鍵（`age1` も含めて 62 文字。サーバーに登録する）。`health-backup-key.txt` の `# public key:` の行にも同じものがある
- `health-backup-key.txt` の `AGE-SECRET-KEY-1…` の行が秘密鍵。**サーバーやリポジトリ、Google Drive には置かない**。パスワードマネージャーと紙の控えなど、2 か所に保管する。失くすとバックアップを復号できない
- 保管したら `health-backup-key.txt` は消す（ごみ箱を経由しない方法で）。クリップボードの履歴に鍵が残っていれば、それも消す

### 2. サーバーに登録する

`BACKUP_TOKEN` を作る（`API_TOKEN` とは別の値にする）。64 文字の英数字が出る。

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

fly.io の secrets に登録する。シェルの履歴に残らないよう、標準入力から渡す。

```sh
fly secrets import -a <アプリ名>
```

実行すると、何も表示されずに入力待ちになる。そこで次の 2 行を **1 行ずつ** 入力する（シェルに貼るコマンドではない）。

```
BACKUP_TOKEN=3f9a…（作ったトークン。64 文字の英数字）
BACKUP_AGE_RECIPIENT=age1…（公開鍵。age1 も含めて 62 文字）
```

1. `BACKUP_TOKEN=` と打ち、続けてトークンだけを貼り付けて Enter
2. `BACKUP_AGE_RECIPIENT=` と打ち、続けて公開鍵だけを貼り付けて Enter
3. カーソルが空の行にある状態で **Ctrl-D** を押す。終わらなければもう一度 Ctrl-D を押す

- 2 行をまとめて貼り付けると、端末によってはシェルがその行を実行してしまい、値がシェルの履歴に残る。1 行ずつ入力する
- `Public key:` などの前置き、秘密鍵（`AGE-SECRET-KEY-…`）、`<` `>` の記号が入ると、サーバーが起動しなくなる（[うまくいかないとき](#うまくいかないとき)）

登録するとサーバーが再起動する。`BACKUP_TOKEN` と `BACKUP_AGE_RECIPIENT` は両方そろって初めて `/backup/health` が有効になる（片方だけだと起動時にエラー）。

登録したら、取得口が有効になったかを確かめる。トークンを付けずに取得して、**401** が返れば正常。

```sh
curl -s -o /dev/null -w '%{http_code}\n' https://<アプリ名>.fly.dev/backup/health
```

| 結果 | 意味 |
|---|---|
| 401 | 正常（取得口が有効で、トークンが無いので拒否された） |
| 404 | `BACKUP_TOKEN` と `BACKUP_AGE_RECIPIENT` がまだ登録されていない |
| 502 | 登録した値が起動時の検査に通らず、サーバーが起動していない（[うまくいかないとき](#うまくいかないとき)） |

### 3. Google Drive のフォルダを作る

保存先のフォルダを作り、URL の `https://drive.google.com/drive/folders/` より後ろの部分（フォルダ ID）を控える。

### 4. GAS を設定する

1. https://script.google.com で新しいプロジェクトを作る
2. 「プロジェクトの設定」で「appsscript.json マニフェスト ファイルをエディタで表示する」をオンにし、[`gas/appsscript.json`](../gas/appsscript.json) の内容で置き換える
3. `コード.gs` を [`gas/backup.gs`](../gas/backup.gs) の内容で置き換える
4. 「プロジェクトの設定」→「スクリプト プロパティ」に次の 3 つを追加する。名前と値は別々の欄に入れ、値の前後に空白や改行を入れない

   | プロパティ | 値 |
   |---|---|
   | `BACKUP_URL` | `https://<アプリ名>.fly.dev/backup/health`（`https://` で始める） |
   | `BACKUP_TOKEN` | 2 で登録したトークン（64 文字の英数字） |
   | `FOLDER_ID` | 3 のフォルダ ID |

5. エディタで `runBackup` を一度実行し、権限を許可する。「このアプリは Google で確認されていません」と出たら、「詳細」→「（プロジェクト名）に移動」で進む。フォルダに `health-YYYY-MM-DD.json.gz.age` ができることを確かめる
6. `install` を一度実行する（毎日 4 時台に `runBackup` を実行するトリガーができる）

### 5. 復元を一度試す

下の「復元」の「1. 中身を確かめる」までを、パスワードマネージャーから取り出した鍵で行う。PC を失ったときと同じ状況で戻せることを、困る前に確かめておく。紙の控えも、一度は紙から打ち込んだ鍵で試しておくと、書き間違いに気づける。

空の DB への書き戻し（「2. 空の DB に書き戻す」）まで試すと、より確実。

## 手動でバックアップを取る

大量に書き込む作業（Takeout の取り込み直しなど）の前は、GAS のエディタで `runBackup` を実行する。同じ日のファイルは置き換わる。

## 復元

本番の DB には直接書かず、**空の別の DB に戻して確かめてから入れ替える**。

### 0. 準備

- Node 24 以上と、リポジトリの `server/` の依存（`server/` で `pnpm install --frozen-lockfile`。pnpm がグローバルに無ければ `npx --yes pnpm@12.8.1 install --frozen-lockfile`）
- Google Drive から落としたバックアップのファイル
- 秘密鍵を書いたファイル。パスワードマネージャーの中身を、**リポジトリの外**に新しいテキストファイルとして保存する。CLI は、ファイルの中の `AGE-SECRET-KEY-` で始まる行を鍵として読む
- 以下のコマンドは **`server/` フォルダで** 実行する（ほかのフォルダでは `Command "restore:backup" not found` になる）。pnpm がグローバルに無ければ、`pnpm` を `npx --yes pnpm@12.8.1` に置き換える

### 1. 中身を確かめる（書き込まない）

```sh
cd <リポジトリ>/server
pnpm restore:backup --file ~/Downloads/health-2026-10-06.json.gz.age --identity ~/health-restore-key.txt --dry-run
```

PowerShell の場合:

```powershell
cd <リポジトリ>\server
pnpm restore:backup --file "$HOME\Downloads\health-2026-10-06.json.gz.age" --identity "$HOME\health-restore-key.txt" --dry-run
```

作成日時、日数、期間が表示される。形が不正な日があれば一覧が出る（その日は除いて復元される）。`バックアップを復号できません` と出たら、鍵が違うか、鍵のファイルの中身が途中で切れている。

### 2. 空の DB に書き戻す

CouchDB の接続情報を環境変数に入れて実行する。`--db` には、まだ存在しないか空の DB の名前を指定する（文書が 1 件でもあれば、別用途の DB を指定した場合も含めて、書き込まずに止まる）。パスワードはシェルの履歴に残らないよう、画面に出さずに読み込む。

```sh
cd <リポジトリ>/server
export COUCHDB_URL=https://<CouchDB のホスト> COUCHDB_USER=<ユーザー名>
read -rs COUCHDB_PASSWORD && export COUCHDB_PASSWORD
pnpm restore:backup --file ~/Downloads/health-2026-10-06.json.gz.age --identity ~/health-restore-key.txt --db health_restore_20261006
unset COUCHDB_PASSWORD
```

PowerShell の場合:

```powershell
cd <リポジトリ>\server
$env:COUCHDB_URL = "https://<CouchDB のホスト>"
$env:COUCHDB_USER = "<ユーザー名>"
$p = Read-Host "CouchDB のパスワード" -AsSecureString
$env:COUCHDB_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($p))
pnpm restore:backup --file "$HOME\Downloads\health-2026-10-06.json.gz.age" --identity "$HOME\health-restore-key.txt" --db health_restore_20261006
Remove-Item Env:COUCHDB_PASSWORD
```

### 3. 確かめてから入れ替える

1. 書き戻した DB の件数と期間を確かめる（CouchDB の管理画面、または `--dry-run` の表示と比べる）
2. `server/fly.toml` の `[env]` にある `COUCHDB_HEALTH_DB = "health"` を、書き戻した DB の名前に変えてデプロイする。元に戻すときは `health` に戻してデプロイする
3. `sync:notes` でノートを作り直し、内容を確かめる
4. バックアップを取った時刻より後のデータは入っていない。Android アプリの「開始日を指定して送る」で、その日以降を送り直す（90 日より前は Takeout から取り込む）
5. 問題なければ、古い DB は一定期間残してから削除する
6. 鍵を書いたファイルを消す（ごみ箱を経由しない方法で）

## うまくいかないとき

### secrets を登録したら、サーバーが応答しなくなった（502）

起動時の設定の検査で止まり、再起動を繰り返している。ログに `環境変数が不正です` と、どの値が不正かが出る（`--no-tail` を付けると、表示が流れ続けずに終わる）。

```sh
fly logs -a <アプリ名> --no-tail
```

| ログの行 | 原因 |
|---|---|
| `BACKUP_AGE_RECIPIENT: age の公開鍵（age1...）を指定してください` | 公開鍵の値が違う。前置きが付いている、途中で切れている、秘密鍵を入れた、`<` `>` が残っている、など |
| `BACKUP_TOKEN: 32文字以上が必要です` / `空白・改行・制御文字・全角文字を含めないでください` / `英数字と . _ ~ + / - （末尾の = は可）だけで指定してください` | トークンが短い、または使えない文字（空白・`<` `>`・全角など）を含む |
| `BACKUP_TOKEN: BACKUP_TOKEN と BACKUP_AGE_RECIPIENT は両方設定するか…` | どちらか片方だけが登録されている |
| `BACKUP_TOKEN: BACKUP_TOKEN には API_TOKEN と別の値を…` | `API_TOKEN` と同じ値を登録した |

- 間違えた値だけを `fly secrets import` で登録し直せばよい（入力しなかったほかの secrets はそのまま残る）。正しい値が入れば、サーバーは自動で再起動して戻る
- すぐにサーバーを戻したいときは、バックアップ用の 2 つを外す。バックアップは止まるが、サーバーはバックアップ無しの状態で起動する。あとで改めて登録する

  ```sh
  fly secrets unset BACKUP_TOKEN BACKUP_AGE_RECIPIENT -a <アプリ名>
  ```

### GAS の実行が `サーバーが HTTP <番号> を返しました` で失敗する

| 番号 | 原因と対処 |
|---|---|
| 401 | トークンの形は正しいが、値がサーバーと一致していない。`API_TOKEN` を入れた、トークンを 2 回作って別々の値を登録した、など。下の方法でどちらが違うかを確かめ、両方に同じ値を登録し直す |
| 400 | プロパティの `BACKUP_TOKEN` に、トークンに使えない文字（途中の空白・`<` `>`・全角など）が入っている |
| 404 | サーバーに `BACKUP_TOKEN` と `BACKUP_AGE_RECIPIENT` が登録されていない、または `BACKUP_URL` のパスが違う |
| 301 / 302 | `BACKUP_URL` が `http://` になっている（GAS はリダイレクトを追わない）。`https://` にする |
| 502 / 503 | サーバーが起動していない（上の節） |

手元のトークンがサーバーと一致しているかは、次のように確かめられる（`read -rs` で読むので、トークンは画面にも履歴にも残らない）。200 ならサーバーの値と一致していて、GAS のプロパティのほうが違う。401 なら手元の値もサーバーと違う。

```sh
read -rs T
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $T" https://<アプリ名>.fly.dev/backup/health
unset T
```

分からなければ、新しいトークンを作り、サーバー（`fly secrets import`）と GAS の両方に同じ値を登録し直す。

## 確認済みのこと

- バックアップ → 復号 → 空の DB への書き戻しで、元の DB と中身が一致する（CouchDB 3 で確認）
- 違う秘密鍵では復号できない。データのある DB には書き戻さない
