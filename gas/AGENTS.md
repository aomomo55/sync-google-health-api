# gas/AGENTS.md

Google Apps Script で作業するときの指示。リポジトリ全体の約束は [ルートの AGENTS.md](../AGENTS.md) にあり、合わせて読むこと。設定と使い方は [docs/backup.md](../docs/backup.md) にある。

## 構成

- `backup.gs` サーバーの `GET /backup/health` から、age で暗号化済みのバックアップを取得して Google Drive に保存し、古い世代を消す。中身は復号しない
- `appsscript.json` `backup.gs` のプロジェクトの設定（タイムゾーン、OAuth スコープ）
- `room-climate.gs` 30 分おきに SwitchBot API で寝室の温湿度計の値を読み、サーバーの `POST /room/readings` へ送る（[docs/room-climate.md](../docs/room-climate.md)、[ADR 0033](../docs/adr/0033-room-climate-readings.md)）。バックアップとは別のプロジェクトに置く
- `room-climate.appsscript.json` `room-climate.gs` のプロジェクトの `appsscript.json`

## 前提

- リポジトリから自動では配置されない。利用者が GAS のエディタに手でコピーして使う。変えたら、利用者がコピーし直す必要があることを PR に書く
- テストもビルドも無い。変えたら `backup.gs` は [docs/backup.md](../docs/backup.md) の手順で `runBackup` を、`room-climate.gs` は [docs/room-climate.md](../docs/room-climate.md) の手順で `recordRoomClimateDryRun` と `recordRoomClimate` を 1 度実行して確かめ、確かめたことを PR に書く
- トークンやフォルダ ID はスクリプト プロパティに置く。コードやログ、通知のメールに出さない
- `oauthScopes` は使う機能の分だけにする
