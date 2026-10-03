# 0008: Android アプリの送信方式と Health Connect の項目の対応

- ステータス: 採用
- 日付: 2026-10-04

## 背景

[0001](0001-health-connect-as-data-source.md) のとおり、Health Connect のデータを自作の Android アプリでサーバーへ送る。
利用者の端末は Android 16。Health Connect には次の項目のデータがある: エクササイズ、獲得標高、距離、総消費カロリー、速度、登った階数、歩数、安静時の心拍数、酸素飽和度、心拍数、栄養、基礎代謝率、体脂肪、体重、睡眠。

Takeout（Google Fit）由来の日次ノートには、Health Connect に対応する項目がないものがある。

## 決定

- **送信方式**: 6 時間ごとに直近 7 日分を送り直す（睡眠や歩数は後から同期されることがあるため）。サーバーは内容が変わらないノートを書き込まないので、送り直しても Vault は無駄に更新されない。初回は「過去30日を送る」で Takeout の終わり（2026-09-07）との間を埋める（Health Connect は追加の権限なしで、権限付与の 30 日前まで読める）。
- **項目の対応**:

| 日次ノートの項目 | Health Connect | 備考 |
|---|---|---|
| 歩数・距離・消費カロリー | Steps / Distance / TotalCaloriesBurned の日次集計 | 集計 API が複数アプリの重複を除く |
| 平均/最大/最小心拍・安静時心拍 | HeartRate / RestingHeartRate の日次集計 | 安静時心拍は Takeout にはなかった |
| 体重・体脂肪率 | Weight の日次平均 / その日最後の BodyFat | |
| 睡眠 | SleepSession（ステージ付き） | 起床日に振り分け、データ元を 1 つに絞り（睡眠ステージを持つ記録を優先し、その中で合計時間が最も長いもの）、最長を本睡眠・残りを仮眠とする（Takeout と同じ規則） |
| 運動時間・ウォーキング分 | ExerciseSession の記録時間の合計（重なりは除く） | **Google Fit の Move Minutes とは定義が違う近似** |
| ハートポイント・強めの運動 | なし | 2026-09-08 以降は空欄 |

- 送信元は `source: "health_connect"` とする。Takeout と重なる日は、サーバーのマージで Health Connect の値が上書きし、Health Connect にない項目（ハートポイントなど）は Takeout の値が残る。
- API トークンは Android Keystore で暗号化して保存する。エラーの収集サービス（Sentry など）は入れない（利用者は一人で、健康データが第三者のサービスに渡るおそれがあるため）。
- デバッグ署名の APK を手動でインストールする（開発者モードは不要）。

## 検討した選択肢

| 選択肢 | 長所 | 短所 |
|---|---|---|
| **自作アプリ** | サーバーの形式に合わせて日次サマリーを作れる。睡眠の扱いを Takeout と揃えられる | 開発・保守が必要。手動インストール |
| [HC Webhook](https://github.com/mcnaveen/health-connect-webhook) | Google Play で配布され保守されている。決めた間隔で Webhook に送れる | 送信形式に合わせてサーバー側で集計し直す必要がある。睡眠ステージをどこまで送れるかは未確認 |
| [HCGateway](https://github.com/CoolCoderSJ/HCGateway) | Health Connect を REST API として扱える | アプリ・サーバー・Appwrite を含む大きな構成 |

HC Webhook は自作アプリを作った後に見つけた。自作アプリの保守が負担になったら、切り替えを検討する。

## 結果

- 2026-09-08 以降の運動時間は、Takeout 期間の値と定義が異なるため、グラフで段差が出る可能性がある
- 自動送信が止まっても気づきにくい。ダッシュボードの最新日付で確認する。必要になったら、送信が続けて失敗したときに通知を出す機能を足す
