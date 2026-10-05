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
        val from = to.minusDays(days - 1L)

        var tally = SyncTally()
        for ((s, e) in chunkRanges(from, to)) {
            val summaries = reader.readDays(s, e, includeNutrition)
            for (chunk in chunkDays(summaries)) {
                when (val r = IngestClient.post(store.serverUrl, token, chunk)) {
                    // 範囲外で拒否された日があっても他の日は保存されているので、続きのチャンクも送る
                    is IngestResult.Success -> tally = tally.add(chunk.size, r.ok)
                    IngestResult.Unauthorized -> return SyncOutcome(SyncStatus.AUTH_ERROR, "トークンが正しくありません")
                    is IngestResult.ClientError -> return SyncOutcome(SyncStatus.FAILED, r.message)
                    is IngestResult.Retryable -> return SyncOutcome(SyncStatus.RETRYABLE, r.message)
                }
            }
        }

        return SyncOutcome(SyncStatus.OK, buildSyncMessage(tally, includeNutrition))
    }

    fun formatTime(millis: Long): String =
        if (millis == 0L) "未実行" else SimpleDateFormat("yyyy/MM/dd HH:mm", Locale.JAPAN).format(Date(millis))
}
