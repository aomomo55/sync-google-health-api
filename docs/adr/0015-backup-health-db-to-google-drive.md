# 0015: health DB をサーバーが暗号化して返し、GAS が Google Drive に保存する

- ステータス: 採用
- 日付: 2026-10-06

## 背景

健康データは自前の CouchDB（`health` DB）にあるが、バックアップが無かった（Issue #25）。Takeout とアプリから作り直せる部分もあるが、Takeout の書き出しより後で Health Connect から読めなくなった期間は作り直せない。昔の Fitbit のデータは、アカウント移行の期限を過ぎて取れなくなった。

決める必要があったのは、どこで動かすか、Google Drive への認証、暗号化、失敗に気づく方法。

## 決定

- **サーバーが `GET /backup/health` で、全期間の日次データを JSON → gzip → age（公開鍵）で暗号化して返す**。秘密鍵はサーバーに置かず、利用者の手元だけに置く
- **GAS（Google Apps Script）が 1 日 1 回それを取得し、Google Drive に保存する**。日次は最新 7 世代、日曜の分を週次として最新 5 世代残す
- バックアップの取得には専用の `BACKUP_TOKEN` を使う。`API_TOKEN` とは別の値を必須にし、経路も `/api` と分ける。`BACKUP_TOKEN` ではデータを書き込めず、`API_TOKEN` ではバックアップを取れない
- 失敗したときは、GAS から自分宛てにメールを送る
- 前回より日数が減ったときは古い世代を消さず、メールで知らせる
- 復元は CLI（`restore:backup`）で空の別の DB に書き戻し、確かめてから `COUCHDB_HEALTH_DB` を切り替える。手順は [docs/backup.md](../backup.md)
- 対象は `health` DB だけ。Vault（LiveSync の DB）は E2E で暗号化されていて各端末にもコピーがあるので、別に考える

## 検討した選択肢

| 選択肢 | 長所 | 短所 |
|---|---|---|
| **サーバーが暗号化して返し、GAS が Drive に置く** | Drive への認証を GAS（自分の Google アカウント）に任せられ、OAuth のリフレッシュトークンを管理しなくてよい。時刻を決めて動かせる。失敗をメールで知らせやすい | GAS のコードはリポジトリから手でコピーする。GAS とサーバーの 2 か所の設定が要る |
| fly.io の定期実行のマシンから Drive に置く | 秘密情報が fly にまとまる | Drive への書き込みに、個人アカウントの OAuth のリフレッシュトークンを管理する必要がある。定期実行は hourly / daily などの大まかな指定しかできない |
| GitHub Actions の定期実行 | 実行の履歴が見える | リポジトリが公開なので、ログや成果物にデータが出ない作りを保ち続ける必要がある。Drive への認証は fly と同じ問題がある |
| 暗号化にパスフレーズ（共通鍵）を使う | 仕組みが単純 | サーバーに置いたパスフレーズが漏れると、Drive のバックアップも復号できる |
| `API_TOKEN` をバックアップにも使う | 秘密情報が増えない | GAS から漏れると、データの書き込みもできてしまう |

## 結果

- サーバー・GAS・Google Drive のどこから漏れても、秘密鍵が無ければ中身は読めない
- 秘密鍵を失くすと復号できない。保管は利用者の責任になる
- `age-encryption`（age の作者による TypeScript 実装）に依存する
- GAS のコード（`gas/`）を変えたら、GAS のエディタに手でコピーする必要がある
- サーバーは全期間をメモリに載せて暗号化する。千数百日分で 1 MB 程度なので今は問題ないが、データが大きく増えたらストリームにする

## 参考

- https://github.com/FiloSottile/age
- https://github.com/FiloSottile/typage
- https://developers.google.com/apps-script/reference/url-fetch/url-fetch-app
- https://developers.google.com/apps-script/guides/triggers/installable
