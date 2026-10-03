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
    suspend fun run(context: Context, days: Int, requireBackground: Boolean = false): SyncOutcome {
        val store = SettingsStore(context)
        val outcome = try {
            execute(context, store, days, requireBackground)
        } catch (e: SecurityException) {
            SyncOutcome(SyncStatus.FAILED, "ヘルスコネクトの権限が不足しています。「権限を付与」を押してください")
        } catch (e: Exception) {
            SyncOutcome(SyncStatus.FAILED, "予期しないエラー: ${e.javaClass.simpleName} ${e.message ?: ""}".trim())
        }
        store.lastSyncMillis = System.currentTimeMillis()
        store.lastResult = outcome.message
        return outcome
    }

    private suspend fun execute(context: Context, store: SettingsStore, days: Int, requireBackground: Boolean): SyncOutcome {
        val token = store.loadToken()
        if (token.isNullOrEmpty()) return SyncOutcome(SyncStatus.FAILED, "API トークンが設定されていません")

        val status = HealthConnectClient.getSdkStatus(context)
        if (status != HealthConnectClient.SDK_AVAILABLE) {
            return SyncOutcome(SyncStatus.FAILED, "ヘルスコネクトが利用できません")
        }

        val reader = HealthReader(context)
        val granted = reader.grantedPermissions()
        val required = if (requireBackground) HealthPermissions.all else HealthPermissions.all - BACKGROUND
        if (!granted.containsAll(required)) {
            return SyncOutcome(SyncStatus.FAILED, "ヘルスコネクトの権限が不足しています。「権限を付与」を押してください")
        }

        val zone = ZoneId.systemDefault()
        val to = LocalDate.now(zone)
        val from = to.minusDays(days - 1L)

        var sent = 0
        var notesWritten = 0
        var notesUnchanged = 0
        var notesFailed = 0
        val noteErrors = mutableListOf<String>()
        for ((s, e) in chunkRanges(from, to)) {
            val summaries = reader.readDays(s, e)
            for (chunk in chunkDays(summaries)) {
                when (val r = IngestClient.post(store.serverUrl, token, chunk)) {
                    is IngestResult.Success -> {
                        sent += chunk.size
                        r.ok.notes?.let {
                            notesWritten += it.written
                            notesUnchanged += it.unchanged
                            notesFailed += it.failed
                            it.error?.let { err -> noteErrors += err }
                        }
                    }
                    IngestResult.Unauthorized -> return SyncOutcome(SyncStatus.AUTH_ERROR, "トークンが正しくありません")
                    is IngestResult.ClientError -> return SyncOutcome(SyncStatus.FAILED, r.message)
                    is IngestResult.Retryable -> return SyncOutcome(SyncStatus.RETRYABLE, r.message)
                }
            }
        }

        val msg = buildString {
            append("${sent}日分を送信しました")
            append(" / ノート 更新${notesWritten}・変更なし${notesUnchanged}・失敗${notesFailed}")
            if (noteErrors.isNotEmpty()) append(" / ノートエラー: ${noteErrors.distinct().joinToString()}")
        }
        return SyncOutcome(SyncStatus.OK, msg)
    }

    private val BACKGROUND = setOf(androidx.health.connect.client.permission.HealthPermission.PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND)

    fun formatTime(millis: Long): String =
        if (millis == 0L) "未実行" else SimpleDateFormat("yyyy/MM/dd HH:mm", Locale.JAPAN).format(Date(millis))
}
