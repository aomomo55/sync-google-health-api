# 0001: 健康データの取得元を Health Connect + 自作 Android アプリにする

- ステータス: 採用
- 日付: 2026-10-03

## 背景

当初は「Google Health のデータを API で取得し、Claude が Obsidian（当初は Notion）のダッシュボードに登録する」構成を考えていた。
サーバーは Google のデータをサーバー側から取りに行く前提だった。

2026-10-03 時点で調べたところ、サーバーから個人の健康データを取得できる Google の API はどれも使えなかった。

| API | 状況 |
|---|---|
| Google Health API v4 | 2026-03 に公開されたが、「新規プロジェクトは受け付けていない」と公式に明記されている |
| Fitbit Web API | 2026-10-30 に完全停止 |
| Google Fit REST API | 非推奨。2024-05 から新規登録停止、2026 年中に停止予定 |
| Health Connect | Android 端末の中だけで動く仕組みで、サーバー向けの REST API はない |

Claude アプリ（Android）の Health Connect 連携も、利用者の環境（日本）では提供されていなかった。
（2026-10-03 追記: Health Connect のアプリ一覧に Claude は表示され、権限も付与できたが、Claude からはデータが見えなかった）

また、Google Takeout を調べた結果、スマートウォッチのデータはメーカーの公式アプリから Health Connect に書き込まれ、Google Fit はそれを読み込んでいるだけだと分かった（データソース名の末尾が `health_platform`）。
ステージ付きの睡眠データもこの経路で記録されている。

## 決定

自作の Android アプリで Health Connect から日次データを読み、サーバーへ送信する（取りに行く方式から、送ってもらう方式に変える）。

- アプリは Kotlin で作り、開発者モードを使わずに APK を手動でインストールする（「提供元不明のアプリ」の許可だけで足りる）
- 毎日バックグラウンドで送信し、初回は過去 30 日分を送る
- 2026-09-07 以前の過去データは Google Takeout（Google Fit 形式）から取り込む

## 検討した選択肢

| 選択肢 | 長所 | 短所 |
|---|---|---|
| Google Health API v4 | サーバー完結。OAuth で取得できる | 新規プロジェクト受付停止中で使えない。使えてもテスト状態ではリフレッシュトークンが 7 日で失効する |
| Fitbit Web API / Google Fit REST API | 実績がある | 停止・新規登録不可 |
| Claude アプリの Health Connect 連携 | 自作不要 | 日本で提供されていない |
| **Health Connect + 自作 Android アプリ** | Google の API の受付状況に左右されない。Google Fit と同じデータ（睡眠ステージ含む）が取れる | Android アプリの開発・保守が必要 |

## 結果

- Google の OAuth やトークン失効の問題がなくなる
- Android アプリの開発が必要になる。Health Connect は既定で権限付与の 30 日前までしか読めず、それより前を読むには履歴読み取りの権限、バックグラウンドで読むにはバックグラウンド読み取りの権限を別に求める必要がある
- Google が進めている Android の開発者本人確認の義務化が、日本で手動インストールにどう影響するかは未確認

## 参考

- https://developers.google.com/health/setup
- https://developers.google.com/health/release-notes
- https://developers.google.com/health/migration
- https://developer.android.com/health-and-fitness/health-connect/migration/fit
