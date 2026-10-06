package com.syncgooglehealth.app

import android.content.Context
import androidx.health.connect.client.HealthConnectClient
import java.text.SimpleDateFormat
import java.time.LocalDate
import java.time.ZoneId
import java.util.Date
import java.util.Locale

enum class SyncStatus { OK, AUTH_ERROR, RETRYABLE, FAILED }

data class SyncOutcome(
    val status: SyncStatus,
    val message: String,
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
        store.lastSyncMillis = System.currentTimeMillis()
        store.lastResult = outcome.message
        return outcome
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
        val includeHistory = PermissionPolicy.canReadHistory(granted)

        // チャンクごとの結果と読めなかった日数を積み上げ、途中で return するループなので var
        var tally = SyncTally()
        var unreadableDays = 0
        for ((s, e) in chunkRanges(from, to)) {
            val skipUnreadable = !includeHistory && needsHistoryPermission(s, to)
            val (summaries, unreadable) = readChunk(reader, s, e, includeNutrition, skipUnreadable)
            unreadableDays += unreadable
            for (chunk in chunkDays(summaries)) {
                when (val r = IngestClient.post(store.serverUrl, token, chunk)) {
                    // 範囲外で拒否された日があっても他の日は保存されているので、続きのチャンクも送る
                    is IngestResult.Success -> tally = tally.add(chunk.size, r.ok)
                    IngestResult.Unauthorized -> return SyncOutcome(SyncStatus.AUTH_ERROR, "トークンが正しくありません")
                    is IngestResult.ClientError -> return SyncOutcome(SyncStatus.FAILED, r.message)
                    is IngestResult.Retryable -> return SyncOutcome(SyncStatus.RETRYABLE, r.message)
                }
            }
            onProgress(formatProgress(from, to, s, e))
        }

        val message = buildSyncMessage(tally, includeNutrition)
        val note = if (unreadableDays > 0) "（履歴の権限が無いため、読めなかった ${unreadableDays} 日分は送っていません）" else ""
        return SyncOutcome(SyncStatus.OK, message + note)
    }

    // [s, e] を読み、読めた日と読めなかった日数を返す。
    // 履歴の権限が無いと、権限を許可した日の 30 日前より前を含む読み取りは SecurityException になる。
    // skipUnreadable のときは 1 日ずつ読み直し、読めた日だけを返す
    private suspend fun readChunk(
        reader: HealthReader,
        s: LocalDate,
        e: LocalDate,
        includeNutrition: Boolean,
        skipUnreadable: Boolean,
    ): Pair<List<DailySummary>, Int> =
        try {
            reader.readDays(s, e, includeNutrition) to 0
        } catch (ex: SecurityException) {
            if (!skipUnreadable) throw ex
            val perDay = s.datesUntil(e.plusDays(1)).toList().map { d ->
                try {
                    reader.readDays(d, d, includeNutrition)
                } catch (_: SecurityException) {
                    null
                }
            }
            perDay.filterNotNull().flatten() to perDay.count { it == null }
        }

    fun formatTime(millis: Long): String =
        if (millis == 0L) "未実行" else SimpleDateFormat("yyyy/MM/dd HH:mm", Locale.JAPAN).format(Date(millis))
}
