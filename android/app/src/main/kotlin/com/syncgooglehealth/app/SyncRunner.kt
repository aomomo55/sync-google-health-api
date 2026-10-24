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
    // 成功したが注意が必要なこと。結果の文に埋もれないよう、画面では別の行に WARNING で出す
    val warning: String? = null,
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
        val texts = ContextTexts(context)
        val outcome = try {
            execute(context, texts, store, days, requireBackground, startDate, onProgress)
        } catch (e: SecurityException) {
            SyncOutcome(SyncStatus.FAILED, texts.get(R.string.sync_message_permission_missing))
        } catch (e: Exception) {
            SyncOutcome(
                SyncStatus.FAILED,
                texts.get(R.string.sync_message_unexpected_error, e.javaClass.simpleName, e.message ?: "").trim(),
            )
        }
        val now = System.currentTimeMillis()
        val succeeded = outcome.status == SyncStatus.OK
        val streak = nextFailureStreak(store.syncHistory().failureStreak, succeeded, now)
        store.recordSync(now, outcome.message, succeeded, streak, outcome.warning)
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
                    texts = ContextTexts(context),
                    status = outcome.status,
                    message = outcome.message,
                    lastSuccess = store.syncHistory().lastSuccessMillis?.let { formatTime(context, it) },
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
                if (MissingSleepNotifier.notify(context, missingSleepNotice(ContextTexts(context), now.toLocalTime()))) {
                    store.lastMissingSleepNotified = now.toLocalDate()
                }
            }
            MissingSleepAction.CANCEL -> MissingSleepNotifier.cancel(context)
            MissingSleepAction.NONE -> Unit
        }
    }

    private suspend fun execute(
        context: Context,
        texts: Texts,
        store: SettingsStore,
        days: Int,
        requireBackground: Boolean,
        startDate: LocalDate?,
        onProgress: (String) -> Unit,
    ): SyncOutcome {
        val token = when (val t = store.readToken()) {
            is StoredToken.Available -> t.token
            StoredToken.None -> return SyncOutcome(SyncStatus.FAILED, texts.get(R.string.sync_message_token_none))
            // Keystore の一時的な不調。保存データは残しているので時間をおいて再試行する
            StoredToken.Unavailable -> return SyncOutcome(SyncStatus.RETRYABLE, texts.get(R.string.sync_message_token_unavailable))
        }

        val status = HealthConnectClient.getSdkStatus(context)
        if (status != HealthConnectClient.SDK_AVAILABLE) {
            return SyncOutcome(SyncStatus.FAILED, texts.get(R.string.sync_message_health_connect_unavailable))
        }

        val reader = HealthReader(context)
        val granted = reader.grantedPermissions()
        val required = PermissionPolicy.required(HealthPermissions.all, requireBackground)
        if (!granted.containsAll(required)) {
            return SyncOutcome(SyncStatus.FAILED, texts.get(R.string.sync_message_permission_missing))
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
                when (val r = IngestClient.post(texts, store.serverUrl, token, chunk)) {
                    // 範囲外で拒否された日があっても他の日は保存されているので、続きのチャンクも送る
                    is IngestResult.Success -> tally = tally.add(chunk.size, r.ok)
                    IngestResult.Unauthorized -> return SyncOutcome(SyncStatus.AUTH_ERROR, texts.get(R.string.sync_message_token_invalid))
                    is IngestResult.ClientError -> return SyncOutcome(SyncStatus.FAILED, r.message)
                    is IngestResult.Retryable -> return SyncOutcome(SyncStatus.RETRYABLE, r.message)
                }
            }
            onProgress(formatProgress(texts, readFrom, to, s, e))
        }

        val message = buildSyncMessage(texts, tally, includeNutrition)
        val note = if (skippedDays > 0) texts.get(R.string.sync_message_history_skipped, readFrom, skippedDays) else ""
        return SyncOutcome(SyncStatus.OK, message + note, hasTodaySleep, buildRejectedWarning(texts, tally))
    }

    fun formatTime(context: Context, millis: Long): String =
        if (millis == 0L) context.getString(R.string.sync_time_never) else SimpleDateFormat("yyyy/MM/dd HH:mm", Locale.JAPAN).format(Date(millis))
}
