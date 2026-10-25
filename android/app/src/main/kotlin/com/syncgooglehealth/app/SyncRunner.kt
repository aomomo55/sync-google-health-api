package com.syncgooglehealth.app

import android.content.Context
import androidx.health.connect.client.HealthConnectClient
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import kotlin.coroutines.cancellation.CancellationException

enum class SyncStatus { OK, AUTH_ERROR, RETRYABLE, FAILED }

data class SyncOutcome(
    val status: SyncStatus,
    val message: String,
    // 送った範囲に今日 (起床した日) の睡眠があったか。送信が成功したときだけ意味を持つ
    val hasTodaySleep: Boolean = false,
    // 成功したが注意が必要なこと。結果の文に埋もれないよう、画面では別の行に WARNING で出す。
    // 複数あるときは WARNING_LINE_SEPARATOR で区切り、1 つずつ別の行にする
    val warning: String? = null,
    // ノートを書き込めなかったときの文 (送信が成功したときだけ)。書き込めていれば null
    val noteFailure: String? = null,
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
        } catch (e: CancellationException) {
            // ワーカーの停止や画面側の取り消しは失敗ではないので、記録も通知もせずに投げ直す
            throw e
        } catch (e: SecurityException) {
            SyncOutcome(SyncStatus.FAILED, texts.get(R.string.sync_message_permission_missing))
        } catch (e: Exception) {
            SyncOutcome(
                SyncStatus.FAILED,
                texts.get(R.string.sync_message_unexpected_error, e.javaClass.simpleName, e.message ?: "").trim(),
            )
        }
        val now = System.currentTimeMillis()
        val notesFailed = outcome.noteFailure != null
        val succeeded = attemptSucceeded(outcome.status, notesFailed)
        val streak = nextFailureStreak(store.syncHistory().failureStreak, succeeded, now)
        store.recordSync(now, outcome.message, succeeded, streak, outcome.warning, notesFailed)
        // 通知は補助なので、失敗しても送信の結果は変えない
        runCatching { updateFailureNotice(context, store, outcome, streak, now, requireBackground) }
        // 睡眠の有無はデータを送れていれば分かるので、ノートの失敗にかかわらず判定する
        if (outcome.status == SyncStatus.OK) {
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
        val window = store.sleepCheckWindow
        when (syncFailureAction(nowMillis, CALENDAR_ZONE, streak, background, store.lastSyncFailureNotified, window)) {
            SyncFailureAction.NOTIFY -> {
                val now = Instant.ofEpochMilli(nowMillis).atZone(CALENDAR_ZONE)
                val notice = failureNotice(
                    texts = ContextTexts(context),
                    status = outcome.status,
                    message = outcome.noteFailure ?: outcome.message,
                    lastSuccess = store.syncHistory().lastSuccessMillis?.let { formatTime(context, it) },
                    sleepUnchecked = now.hour in window,
                )
                // 通知を出せなかった日は記録しない (権限を許可した後の送信で出せるようにする)
                if (SyncFailureNotifier.notify(context, notice)) {
                    store.lastSyncFailureNotified = now.toLocalDate()
                }
            }
            SyncFailureAction.CANCEL -> SyncFailureNotifier.cancel(context)
            SyncFailureAction.NONE -> Unit
        }
    }

    private fun updateMissingSleepNotice(context: Context, store: SettingsStore, hasTodaySleep: Boolean, background: Boolean) {
        val now = LocalDateTime.now(CALENDAR_ZONE)
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
        val to = LocalDate.now(CALENDAR_ZONE)
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
        val noteFailure = buildNoteWarnings(texts, tally).joinToString(WARNING_LINE_SEPARATOR).ifEmpty { null }
        return SyncOutcome(SyncStatus.OK, message + note, hasTodaySleep, buildSyncWarning(texts, tally), noteFailure)
    }

    fun formatTime(context: Context, millis: Long): String =
        if (millis == 0L) context.getString(R.string.sync_time_never) else formatCalendarTime(Instant.ofEpochMilli(millis))
}
