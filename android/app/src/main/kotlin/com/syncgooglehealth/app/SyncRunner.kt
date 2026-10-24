package com.syncgooglehealth.app

import android.content.Context
import androidx.health.connect.client.HealthConnectClient
import java.text.SimpleDateFormat
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId
import java.util.Date
import java.util.Locale

enum class SyncStatus { OK, AUTH_ERROR, RETRYABLE, FAILED }

data class SyncOutcome(
    val status: SyncStatus,
    val message: String,
    // 送った範囲に今日 (起床した日) の睡眠があったか。送信が成功したときだけ意味を持つ
    val hasTodaySleep: Boolean = false,
)

object SyncRunner {
    // ボタンとワーカーの共通の送信処理。結果は SettingsStore にも保存する。
    suspend fun run(
        context: Context,
        days: Int,
        requireBackground: Boolean = false,
        startDate: LocalDate? = null,
        onProgress: (String) -> Unit = {},
    ): SyncOutcome {
        val store = SettingsStore(context)
        val outcome = try {
            execute(context, store, days, requireBackground, startDate, onProgress)
        } catch (e: SecurityException) {
            SyncOutcome(SyncStatus.FAILED, "ヘルスコネクトの権限が不足しています。「権限を付与」を押してください")
        } catch (e: Exception) {
            SyncOutcome(SyncStatus.FAILED, "予期しないエラー: ${e.javaClass.simpleName} ${e.message ?: ""}".trim())
        }
        val now = System.currentTimeMillis()
        val succeeded = outcome.status == SyncStatus.OK
        val streak = nextFailureStreak(store.syncHistory().failureStreak, succeeded, now)
        store.recordSync(now, outcome.message, succeeded, streak)
        // 通知は補助なので、失敗しても送信の結果は変えない
        runCatching { updateFailureNotice(context, store, outcome, streak, now, requireBackground) }
        if (succeeded) {
            runCatching { updateMissingSleepNotice(context, store, outcome.hasTodaySleep, requireBackground) }
        }
        return outcome
    }

    private fun updateFailureNotice(
        context: Context,
        store: SettingsStore,
        outcome: SyncOutcome,
        streak: FailureStreak?,
        nowMillis: Long,
        background: Boolean,
    ) {
        val zone = ZoneId.systemDefault()
        val window = store.sleepCheckWindow
        when (syncFailureAction(nowMillis, zone, streak, background, store.lastSyncFailureNotified, window)) {
            SyncFailureAction.NOTIFY -> {
                val now = Instant.ofEpochMilli(nowMillis).atZone(zone)
                val notice = failureNotice(
                    status = outcome.status,
                    message = outcome.message,
                    lastSuccess = store.syncHistory().lastSuccessMillis?.let { formatTime(it) },
                    sleepUnchecked = now.hour in window,
                )
                SyncFailureNotifier.notify(context, notice)
                store.lastSyncFailureNotified = now.toLocalDate()
            }
            SyncFailureAction.CANCEL -> SyncFailureNotifier.cancel(context)
            SyncFailureAction.NONE -> Unit
        }
    }

    private fun updateMissingSleepNotice(context: Context, store: SettingsStore, hasTodaySleep: Boolean, background: Boolean) {
        val now = LocalDateTime.now(ZoneId.systemDefault())
        val showing = MissingSleepNotifier.isShowing(context)
        when (missingSleepAction(now, hasTodaySleep, background, store.lastMissingSleepNotified, showing, store.sleepCheckWindow)) {
            MissingSleepAction.NOTIFY -> {
                if (MissingSleepNotifier.notify(context, missingSleepNotice(now.toLocalTime()))) {
                    store.lastMissingSleepNotified = now.toLocalDate()
                }
            }
            MissingSleepAction.CANCEL -> MissingSleepNotifier.cancel(context)
            MissingSleepAction.NONE -> Unit
        }
    }

    private suspend fun execute(
        context: Context,
        store: SettingsStore,
        days: Int,
        requireBackground: Boolean,
        startDate: LocalDate?,
        onProgress: (String) -> Unit,
    ): SyncOutcome {
        val token = when (val t = store.readToken()) {
            is StoredToken.Available -> t.token
            StoredToken.None -> return SyncOutcome(SyncStatus.FAILED, "API トークンが設定されていません。設定画面で入力し直してください")
            // Keystore の一時的な不調。保存データは残しているので時間をおいて再試行する
            StoredToken.Unavailable -> return SyncOutcome(SyncStatus.RETRYABLE, "API トークンを一時的に読み出せませんでした")
        }

        val status = HealthConnectClient.getSdkStatus(context)
        if (status != HealthConnectClient.SDK_AVAILABLE) {
            return SyncOutcome(SyncStatus.FAILED, "ヘルスコネクトが利用できません")
        }

        val reader = HealthReader(context)
        val granted = reader.grantedPermissions()
        val required = PermissionPolicy.required(HealthPermissions.all, requireBackground)
        if (!granted.containsAll(required)) {
            return SyncOutcome(SyncStatus.FAILED, "ヘルスコネクトの権限が不足しています。「権限を付与」を押してください")
        }

        val includeNutrition = PermissionPolicy.canReadNutrition(granted)
        val zone = ZoneId.systemDefault()
        val to = LocalDate.now(zone)
        // 開始日の指定があればそれを使い、無ければ直近 days 日
        val from = startDate ?: to.minusDays(days - 1L)
        val readFrom = readableStart(from, to, PermissionPolicy.canReadHistory(granted))
        val skippedDays = countDays(from, readFrom) - 1

        // チャンクごとの結果 (件数と今日の睡眠の有無) を積み上げ、途中で return するループなので var
        var tally = SyncTally()
        var hasTodaySleep = false
        for ((s, e) in chunkRanges(readFrom, to)) {
            val summaries = reader.readDays(s, e, includeNutrition)
            if (hasSleepOn(summaries, to)) hasTodaySleep = true
            for (chunk in chunkDays(summaries)) {
                when (val r = IngestClient.post(store.serverUrl, token, chunk)) {
                    // 範囲外で拒否された日があっても他の日は保存されているので、続きのチャンクも送る
                    is IngestResult.Success -> tally = tally.add(chunk.size, r.ok)
                    IngestResult.Unauthorized -> return SyncOutcome(SyncStatus.AUTH_ERROR, "トークンが正しくありません")
                    is IngestResult.ClientError -> return SyncOutcome(SyncStatus.FAILED, r.message)
                    is IngestResult.Retryable -> return SyncOutcome(SyncStatus.RETRYABLE, r.message)
                }
            }
            onProgress(formatProgress(readFrom, to, s, e))
        }

        val message = buildSyncMessage(tally, includeNutrition)
        val note = if (skippedDays > 0) "（履歴の権限が無いため、$readFrom より前の $skippedDays 日分は読まずに送っていません）" else ""
        return SyncOutcome(SyncStatus.OK, message + note, hasTodaySleep)
    }

    fun formatTime(millis: Long): String =
        if (millis == 0L) "未実行" else SimpleDateFormat("yyyy/MM/dd HH:mm", Locale.JAPAN).format(Date(millis))
}
