package com.syncgooglehealth.app

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

data class NotesResult(val written: Int, val unchanged: Int, val failed: Int, val error: String?)

data class IngestOk(val written: Int, val notes: NotesResult?)

sealed interface IngestResult {
    data class Success(val ok: IngestOk) : IngestResult
    data object Unauthorized : IngestResult
    data class ClientError(val message: String) : IngestResult
    data class Retryable(val message: String) : IngestResult
}

// レスポンス JSON の解析 (テスト可能にするため分離)。written が無い応答は保存できた証拠にならないので例外にする
fun parseIngestResponse(body: String): IngestOk {
    val obj = Json.parseToJsonElement(body).jsonObject
    val written = obj["written"]?.jsonPrimitive?.intOrNull
        ?: throw IllegalArgumentException("written がありません")
    val notesEl = obj["notes"]
    val notes = (notesEl as? JsonObject)?.let { n ->
        val err = n["error"]?.jsonPrimitive?.contentOrNull
        NotesResult(
            written = n["written"]?.jsonPrimitive?.intOrNull ?: 0,
            unchanged = n["unchanged"]?.jsonPrimitive?.intOrNull ?: 0,
            failed = (n["failed"] as? JsonArray)?.size ?: 0,
            error = err,
        )
    }
    return IngestOk(written, notes)
}

fun parseErrorMessage(body: String): String? = try {
    Json.parseToJsonElement(body).jsonObject["error"]?.jsonPrimitive?.contentOrNull
} catch (_: Exception) {
    null
}

// ステータスコードと本文から結果を決める (テスト可能にするため分離)
fun classifyIngestResponse(code: Int, body: String): IngestResult = when {
    code == 401 -> IngestResult.Unauthorized
    // リダイレクトには従わない (POST の本文やトークンを別の宛先へ送らないため)
    code in 300..399 -> IngestResult.ClientError(
        "サーバーがリダイレクト ($code) を返しました。サーバー URL が正しいか確認してください",
    )
    code in 200..299 -> try {
        IngestResult.Success(parseIngestResponse(body))
    } catch (_: Exception) {
        IngestResult.ClientError("サーバーの応答を解釈できませんでした (保存できたか確認できません)")
    }
    // タイムアウトと流量制限は時間をおけば通るので再試行する
    code == 408 || code == 429 -> IngestResult.Retryable("サーバーが一時的に受け付けませんでした ($code)")
    code in 400..499 ->
        IngestResult.ClientError("送信エラー ($code): ${parseErrorMessage(body) ?: "不明なエラー"}")
    else -> IngestResult.Retryable("サーバーエラー ($code)")
}

object IngestClient {
    private val client = OkHttpClient.Builder()
        .followRedirects(false)
        .followSslRedirects(false)
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .build()

    private val JSON_TYPE = "application/json; charset=utf-8".toMediaType()

    // 通信はメインスレッドで行えない (NetworkOnMainThreadException) ので必ず IO スレッドで実行する
    suspend fun post(serverUrl: String, token: String, days: List<DailySummary>): IngestResult =
        withContext(Dispatchers.IO) { postBlocking(serverUrl, token, days) }

    private fun postBlocking(serverUrl: String, token: String, days: List<DailySummary>): IngestResult {
        val base = serverUrl.trim().trimEnd('/')
        val url = "$base/api/ingest".toHttpUrlOrNull()
        if (url == null || url.scheme != "https") {
            return IngestResult.ClientError("サーバー URL は https:// で始まる正しい URL を入力してください")
        }
        val body = ingestJson.encodeToString(IngestRequest.serializer(), IngestRequest(days))
        val request = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer $token")
            .post(body.toRequestBody(JSON_TYPE))
            .build()
        return try {
            client.newCall(request).execute().use { res ->
                classifyIngestResponse(res.code, res.body.string())
            }
        } catch (e: IOException) {
            IngestResult.Retryable("通信エラー: ${e.message ?: e.javaClass.simpleName}")
        }
    }
}
