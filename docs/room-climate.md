# 寝室の温湿度の取り込み

寝室の温湿度計（SwitchBot）の値を 30 分おきにサーバーへ送り、就寝〜起床の間の室温・湿度を日次ノートに書く。決めた理由は [ADR 0033](adr/0033-room-climate-readings.md)。

## しくみ

```
GAS（30 分おき）──GET /v1.1/devices/<ID>/status──▶ SwitchBot API
 │
 └─POST /room/readings（ROOM_TOKEN）──▶ サーバー ── CouchDB の room:YYYY-MM-DD に保存
                                                    │
Android の送信（1 時間おき）で日次ノートを作り直すとき ─┘
  就寝〜起床の間の値から 夜平均室温・夜最低室温・夜最高室温・夜平均湿度 を書く
```

- サーバーは値を保存するだけで、受け取ったときにはノートを作らない。睡眠のデータが届いた後の送信で、その夜の値が日次ノートに入る
- 就寝〜起床の間に、1 時間あたり平均 1 件以上の値が無い夜は空にする
- `ROOM_TOKEN` は温湿度の書き込みにだけ使える。`/api`（健康データ）や `/backup` には使えない
- GAS は送れなかった値を 2 日分まで残し、次の実行で一緒に送る。失敗したときは、GAS を動かしている Google アカウントにトリガーの失敗通知のメールが届く

## この文書の書き方

- `<…>` は自分の値に置き換える部分。`<` と `>` も含めて置き換える
- コマンドは、特に断りが無ければ bash の書き方。`fly` を WSL で、Node を Windows の PowerShell で使っている場合は、各手順の注記に従う

## 初回の設定

### 1. SwitchBot のトークンを発行する

SwitchBot のアプリで、プロフィール → 設定 → アプリバージョンを 10 回たたくと「開発者向けオプション」が出る。そこでトークンとクライアントシークレットを確かめる。

- 温湿度計の値を API で読むには、ハブ（ハブミニ・ハブ 2 など）につながっていて、クラウドサービスが有効になっている必要がある
- トークンとシークレットは GAS のスクリプト プロパティにだけ置く（サーバーやリポジトリには置かない）

### 2. サーバーに ROOM_TOKEN を登録する

`ROOM_TOKEN` を作る（`API_TOKEN`・`BACKUP_TOKEN` とは別の値にする）。

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

fly.io の secrets に登録する（書き方は [deploy.md](deploy.md#秘密情報を登録する)）。

```sh
fly secrets import -a <アプリ名>
```

入力待ちになったら、次の 1 行を入力し、Enter で空の行に移ってから Ctrl-D で終える。

```
ROOM_TOKEN=<作ったトークン>
```

登録するとサーバーが再起動する。この機能を含む版をデプロイしてから、経路があるかを確かめる（トークンなしで 401 が返れば、経路はできている。404 なら版が古いか `ROOM_TOKEN` が未登録）。

```sh
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://<アプリ名>.fly.dev/room/readings
```

### 3. GAS のプロジェクトを作る

バックアップとは別のプロジェクトにする（使うトークンごとに分けるため）。

1. https://script.google.com で新しいプロジェクトを作る（名前は「寝室の温湿度」など）
2. 「プロジェクトの設定」で「appsscript.json マニフェスト ファイルをエディタで表示する」をオンにし、`appsscript.json` の中身を [gas/room-climate.appsscript.json](../gas/room-climate.appsscript.json) に置き換える
3. `コード.gs` の中身を [gas/room-climate.gs](../gas/room-climate.gs) に置き換えて保存する
4. 「プロジェクトの設定」→「スクリプト プロパティ」に次を登録する

| プロパティ | 値 |
|---|---|
| `SWITCHBOT_TOKEN` | 手順 1 のトークン |
| `SWITCHBOT_SECRET` | 手順 1 のクライアントシークレット |
| `ROOM_URL` | `https://<アプリ名>.fly.dev/room/readings` |
| `ROOM_TOKEN` | 手順 2 のトークン |
| `SWITCHBOT_DEVICE_ID` | 次の手順で調べる |

5. エディタで `listDevices` を選んで実行する（初回は権限の確認が出るので許可する）。実行ログに `デバイスID	名前	種類` が並ぶので、温湿度計の ID を `SWITCHBOT_DEVICE_ID` に登録する
6. `recordRoomClimateDryRun` を実行し、ログに今の温度と湿度が出ることを確かめる（送らない）
7. `recordRoomClimate` を 1 度実行し、ログに「送信しました: 1 件（書き込み 1 / 変更なし 0）」が出ることを確かめる
8. `install` を実行する。30 分おきのトリガーができる（「トリガー」の画面で `recordRoomClimate` があることを確かめる）

GAS のコードを変えたときは、貼り直してから `install` も実行し直す。

## 過去の分を入れる

SwitchBot のアプリの温湿度計の画面 → 一番下の「データのエクスポート」で CSV を書き出す。CSV はリポジトリや Vault の外（ダウンロードのフォルダなど）に置く。

`server/` で実行する。まず送らずに読み、件数と期間を確かめる。

```sh
pnpm import:room-csv --file "<CSV のパス>"
```

送る。`ROOM_TOKEN` は環境変数で渡す。PowerShell の場合:

```powershell
cd <リポジトリ>\server
$p = Read-Host "ROOM_TOKEN" -AsSecureString
$env:ROOM_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($p))
pnpm import:room-csv --file "<CSV のパス>" --api-url https://<アプリ名>.fly.dev
Remove-Item Env:ROOM_TOKEN
```

- 1 回に 1,000 件ずつ送る（`--batch` で 1〜2,000 に変えられる）。同じ分の値は置き換えるので、途中で止まったらもう一度実行すればよい
- 時刻は Asia/Tokyo として読む
- 形の合わない行は送らずに行番号と理由を表示し、最後に終了コード 1 になる

送っただけでは過去の日次ノートは変わらない。`sync:notes` で期間を指定して作り直す（ノートが多いと LiveSync の同期に時間がかかる）。

```sh
pnpm sync:notes --from <CSV の最初の日> --to <昨日> --api-url https://<アプリ名>.fly.dev --include-static
```

`--include-static` を付けると、睡眠ダッシュボード（温湿度のグラフと分析ノートの一覧）も作り直す。

## 分析ノートをダッシュボードに載せる

睡眠ダッシュボードの「分析ノート」には、`Health/` の下にあって、フロントマターに `type: health-analysis` があるノートが並ぶ。

## 困ったとき

| 症状 | 確かめること |
|---|---|
| GAS が「SwitchBot API が HTTP 401」 | トークン・シークレットが正しいか。1 日の上限（10,000 回）を超えていないか |
| GAS が「statusCode 190」や「応答に温度がありません」 | `SWITCHBOT_DEVICE_ID` が温湿度計のものか。ハブがオンラインか |
| GAS が「サーバーが HTTP 404」 | サーバーの版が古いか、`ROOM_TOKEN` が未登録 |
| GAS が「サーバーが HTTP 401」 | GAS とサーバーの `ROOM_TOKEN` が同じ値か |
| 日次ノートの温湿度が空 | その日の睡眠の就寝・起床の時刻があるか。その夜の値が 1 時間あたり 1 件以上届いているか |
