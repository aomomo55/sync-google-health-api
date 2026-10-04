# ヘルス同期 (Android)

ヘルスコネクトの日次データを集計し、サーバーの `POST /api/ingest` へ送るアプリです。

## ビルド

JDK 21 と Android SDK (platform 36) が必要です。`android/local.properties` に `sdk.dir=...` を書きます (git 管理外)。

```sh
cd android
export JAVA_HOME="/c/Program Files/Eclipse Adoptium/jdk-21.0.9.10-hotspot"
./gradlew testDebugUnitTest assembleDebug
```

APK は `app/build/outputs/apk/debug/app-debug.apk` に出力されます。

## スマホへのインストール (開発者モード不要)

1. `app-debug.apk` を Google ドライブにアップロードする。
2. スマホのドライブアプリからダウンロードする。
3. ファイルマネージャー (または Chrome) で APK を開く。初回は「不明なアプリのインストール」の許可を求められるので、そのアプリに対して許可する。
4. インストール後、許可は元に戻してよい。

## 初回の手順

1. アプリを開き、サーバー URL (`https://<your-app>.fly.dev` の形式) と API トークンを入力して「設定を保存」。
2. 「権限を付与」を押し、ヘルスコネクトの全項目と「バックグラウンドでのデータ読み取り」を許可する。
3. 「過去30日を送る」を押す (権限付与前の履歴は付与の 30 日前までしか読めません)。
4. 以後は 6 時間ごとに WorkManager が直近 7 日分を自動送信します (権限付与と設定保存の後に登録)。

## データの対応

日付は端末のタイムゾーン (Asia/Tokyo) の 0:00 から 24:00 で区切ります。値が無い項目は送信しません。

| 送信項目 | ヘルスコネクトの元データ |
| --- | --- |
| activity.steps | StepsRecord 合計 |
| activity.distance_m | DistanceRecord 合計 (m) |
| activity.calories_kcal | TotalCaloriesBurnedRecord 合計 (kcal) |
| activity.move_minutes | ExerciseSessionRecord の日内合計分 (日の範囲にクリップ、重なりは統合) |
| activity.walking_minutes | 上記のうち ウォーキング のみ |
| heart_rate.avg/max/min_bpm | HeartRateRecord の平均/最大/最小 |
| heart_rate.resting_bpm | RestingHeartRateRecord の平均 |
| body.weight_kg | WeightRecord の平均 |
| body.body_fat_pct | その日の最後の BodyFatRecord |
| sleep.* | SleepSessionRecord。終了時刻の日付 (起床日) に割り当て |
| nutrition.energy_kcal | NutritionRecord の ENERGY_TOTAL の日内合計 (kcal、整数に丸める) |
| nutrition.protein_g / fat_g / carbs_g | NutritionRecord の PROTEIN_TOTAL / TOTAL_FAT_TOTAL / TOTAL_CARBOHYDRATE_TOTAL の日内合計 (g、小数 1 桁) |

栄養 (READ_NUTRITION) は任意の権限です。付与されていなければ栄養だけ送らず、他の項目は送信します。v1.1.0 より前からインストールしている場合は、アップデート後に「権限を付与」をもう一度押してください。

睡眠の詳細:

- 同じ起床日に複数のデータ提供元がある場合は 1 つだけ使う。その日のセッションに浅い / 深い / REM のステージを含む提供元を優先し、その中で合計時間が最長のものを選ぶ。同点なら提供元 ID の辞書順で最小のもの。
- 最長のセッションを主睡眠とし、それ以外のセッションの睡眠分数の合計を `nap_minutes` にする。
- `in_bed` は開始から終了まで。`awake` は AWAKE / OUT_OF_BED / AWAKE_IN_BED の合計、`asleep = in_bed - awake`。`deep` / `light` / `rem` は各ステージの合計。
- ステージが無いセッションは `asleep = in_bed` とし、awake / deep / light / rem は送らない。

### Google Fit との違い

- ハートポイントと「強めの運動」(vigorous) はヘルスコネクトに無いため取得できません。
- 運動時間 (`move_minutes`) は Google Fit の移動ミニット相当ではなく、運動セッションの合計時間による近似です。セッションとして記録されない歩行は含まれません。

## 実機でないと確認できないこと

ヘルスコネクトの実データ取得、権限ダイアログ、バックグラウンド読み取りの可否、WorkManager の定期実行は実機で確認してください。
