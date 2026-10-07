# android/AGENTS.md

Android アプリ（Kotlin / Jetpack Compose）で作業するときの指示。リポジトリ全体の約束は [ルートの AGENTS.md](../AGENTS.md) にあり、合わせて読むこと。ビルドの準備とアプリの使い方は [README.md](README.md) にある。

## 構成

Health Connect から日次サマリーを作り、サーバーの `POST /api/ingest` へ送る。

- 集計ロジックは Android に依存しない純粋な Kotlin にする（`DayAggregator`、`SleepAssigner`、`Chunking` など）。`android.*` / `androidx.*`、I/O、現在時刻、乱数、環境変数を入れない
- 今は 1 つのパッケージ。機能ごとにパッケージを分けたら、複数の機能から使う汎用の部品は `shared` パッケージに置く（ルートの AGENTS.md の `shared` の約束に従う）

## コマンド

`android/` で実行する。JDK 21 が必要で、`JAVA_HOME` を JDK 21 にする。

```sh
./gradlew testDebugUnitTest assembleDebug
```

変更したら testDebugUnitTest / assembleDebug が通ることを確認する。

## 壊しやすい前提

サーバーと Android にまたがる前提（日付、`POST /api/ingest` のマージ、トークンの検査）はルートの AGENTS.md にある。睡眠の元データの選び方など、サーバーの Takeout 取り込みと同じ規則は、両方で同じ入力に対するテストを置く。

## インストール

デバッグ署名の APK を手動でインストールする。手順は [README.md](README.md)。
