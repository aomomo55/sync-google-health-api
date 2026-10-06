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

デバッグ署名の APK を使っている間は、端末の「USB デバッグ」をオフにしておくことをおすすめします (インストールに USB デバッグは不要です。デバッグ署名の APK は adb からアプリのデータを読んだりデバッガーをつないだりできるため、オンのままだと PC につないだときに設定やトークンに触れられる余地が残ります)。

## リリース署名でのビルド (任意)

自分で作った鍵で署名した APK を作れます。鍵の設定が無いときは、今までどおりデバッグビルドだけで使えます (`assembleRelease` は署名なしの APK になります)。

### 1. 鍵を作る

JDK に含まれる `keytool` で作ります。保存場所・別名・氏名などは自分の値に置き換えてください。

```sh
keytool -genkeypair -v \
  -keystore ~/keys/<鍵ファイル名>.jks \
  -alias <鍵の別名> \
  -keyalg RSA -keysize 4096 -validity 10000
```

- 鍵ファイルは **リポジトリの外** に置き、パスワードと一緒に別の場所 (パスワードマネージャーなど) にもバックアップしてください。鍵を失うと、同じアプリとして更新できなくなります (アンインストールして入れ直すことになります)。
- 鍵ファイルとパスワードはコミットしないでください (`android/keystore.properties`・`*.jks`・`*.keystore` は `.gitignore` 済み)。

### 2. 鍵の場所とパスワードを設定する

`android/keystore.properties` (git 管理外) に書きます。`storeFile` の相対パスは `android/` からの位置です。

```properties
storeFile=/home/<ユーザー名>/keys/<鍵ファイル名>.jks
storePassword=<キーストアのパスワード>
keyAlias=<鍵の別名>
keyPassword=<鍵のパスワード>
```

ファイルの代わりに環境変数 `ANDROID_RELEASE_STORE_FILE`・`ANDROID_RELEASE_STORE_PASSWORD`・`ANDROID_RELEASE_KEY_ALIAS`・`ANDROID_RELEASE_KEY_PASSWORD` でも指定できます (ファイルの値が優先)。4 つ揃っていないときは署名しません (ビルド時に警告が出ます)。

### 3. ビルドする

```sh
cd android
./gradlew assembleRelease
```

APK は `app/build/outputs/apk/release/app-release.apk` に出力されます。インストール方法はデバッグ版と同じです。

### デバッグ版からリリース版へ切り替えるとき

署名が違う APK は上書きインストールできないため、**一度デバッグ版をアンインストール** してからリリース版を入れてください。アンインストールすると設定と権限が消えるので、次をやり直します。

- サーバー URL と API トークンの入力
- 「権限を付与」(ヘルスコネクトの全項目とバックグラウンド読み取り)

以後はリリース版同士なら上書きで更新できます。

## 初回の手順

1. アプリを開き、サーバー URL (`https://<your-app>.fly.dev` の形式) と API トークンを入力して「設定を保存」。
2. 「権限を付与」を押し、ヘルスコネクトの全項目と「バックグラウンドでのデータ読み取り」を許可する。
3. 「過去30日を送る」を押す (権限付与前の履歴は付与の 30 日前までしか読めません)。
4. 以後は 6 時間ごとに WorkManager が直近 7 日分を自動送信します (権限付与と設定保存の後に登録)。

設定 (サーバー URL とトークン) はクラウドバックアップや機種変更時の移行に含めません。新しい端末では入力し直してください。保存済みのトークンが読み取れなくなった場合も、アプリは未設定として扱い、再入力を求めます。

### 開始日を指定して送る

集計の規則を直したあとなど、31 日以上前から送り直したいときの操作です。

1. 「開始日を選ぶ」で日付を選ぶ。選べるのは今日から 90 日前までです。それより前は、Google Takeout を取り直して `import:takeout` で取り込んでください。
2. 「開始日を指定して送る」を押す。開始日から今日までを 30 日ずつに区切って読み取り・送信し、区切りごとに「2026-08-01〜2026-08-30 を送信済み（30/60 日）」のように進捗を表示します。最後の結果は「過去30日を送る」と同じ形（送った日数、保存されなかった日）です。

ヘルスコネクトは、既定では「権限を初めて許可した日の 30 日前」より前を読ませません。それより前を読むには、履歴の権限 (`READ_HEALTH_DATA_HISTORY`) が要ります。栄養と同じ任意の権限で、「権限を付与」で一緒に求めます (許可しなくても他の項目は送れます)。

- 履歴の権限が無いまま 30 日より前を選ぶと、画面に注意が出ます。送信は止めず、読めなかった日は送らずに、結果に日数を示します。読めなかった項目は省略して送るので、サーバーの既存の値は消えません。
- 履歴の権限に対応していない端末では、権限の画面に出ません。その場合の 30 日より前は Takeout で取り込んでください。

送信時、サーバーのリダイレクトには従いません (トークンを別の宛先へ送らないため)。リダイレクトのエラーが出たら、サーバー URL が正しいか確認してください。タイムアウト (408)・流量制限 (429)・サーバーエラー (5xx)・通信エラーのときは、自動送信が間隔をあけて再試行します。

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
- 同じ提供元のセッションの間隔が 2 時間以内なら一晩の睡眠として結合する（起床日は結合後の起床時刻で決める）。セッション間の間隔は中途覚醒に数える（[ADR 0013](../docs/adr/0013-merge-split-sleep-sessions.md)）。
- 最も長いまとまりを主睡眠とし、それ以外のセッションの睡眠分数の合計を `nap_minutes` にする。
- `in_bed` は開始から終了まで。`awake` は AWAKE / OUT_OF_BED / AWAKE_IN_BED の合計、`asleep = in_bed - awake`。`deep` / `light` / `rem` は各ステージの合計。
- ステージが無いセッションは `asleep = in_bed` とし、awake / deep / light / rem は送らない。

### Google Fit との違い

- ハートポイントと「強めの運動」(vigorous) はヘルスコネクトに無いため取得できません。
- 運動時間 (`move_minutes`) は Google Fit の移動ミニット相当ではなく、運動セッションの合計時間による近似です。セッションとして記録されない歩行は含まれません。

## 実機でないと確認できないこと

ヘルスコネクトの実データ取得、権限ダイアログ、バックグラウンド読み取りの可否、WorkManager の定期実行は実機で確認してください。
