package com.syncgooglehealth.app

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
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

// 書き込めなかったノート。path は Vault の中のパス (日付が不正なときは「日付 "…"」のような表示用の文)、
// error はサーバーが返す利用者向けの文 (次にすることを含む)。応答の形が不正な要素は、どちらも空にする
data class FailedNote(val path: String, val error: String)

data class NotesResult(val written: Int, val unchanged: Int, val failed: List<FailedNote>, val error: String?)

// 値が範囲外などで保存されなかった日 (同じリクエストの他の日は保存されている)
data class RejectedDay(val date: String, val error: String)

data class IngestOk(val written: Int, val notes: NotesResult?, val rejected: List<RejectedDay> = emptyList())

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
            failed = (n["failed"] as? JsonArray)?.map(::parseFailedNote) ?: emptyList(),
            error = err,
        )
    }
    return IngestOk(written, notes, parseRejected(obj["rejected"]))
}

// 形が不正な要素も、書き込めなかったことは数えたいので捨てずに空の項目にする (理由は「不明」として出す)
private fun parseFailedNote(el: JsonElement): FailedNote {
    val o = el as? JsonObject
    return FailedNote(path = stringField(o, "path"), error = stringField(o, "error"))
}

private fun stringField(o: JsonObject?, key: String): String =
    (o?.get(key) as? JsonPrimitive)?.takeIf { it.isString }?.content.orEmpty()

// rejected が無いのは古いサーバー (拒否される日が無い) なので空とみなす。
// あるのに解釈できないときは、保存されなかった日を見落とさないよう例外にする
private fun parseRejected(el: JsonElement?): List<RejectedDay> {
    if (el == null || el is JsonNull) return emptyList()
    val arr = el as? JsonArray ?: throw IllegalArgumentException("rejected が配列ではありません")
    return arr.map { item ->
        val o = item as? JsonObject ?: throw IllegalArgumentException("rejected の要素が不正です")
        val date = (o["date"] as? JsonPrimitive)?.contentOrNull
            ?: throw IllegalArgumentException("rejected に date がありません")
        RejectedDay(date, (o["error"] as? JsonPrimitive)?.contentOrNull ?: "")
    }
}

fun parseErrorMessage(body: String): String? = try {
    Json.parseToJsonElement(body).jsonObject["error"]?.jsonPrimitive?.contentOrNull
} catch (_: Exception) {
    null
}

// ステータスコードと本文から結果を決める (テスト可能にするため分離)
fun classifyIngestResponse(texts: Texts, code: Int, body: String): IngestResult = when {
    code == 401 -> IngestResult.Unauthorized
    // リダイレクトには従わない (POST の本文やトークンを別の宛先へ送らないため)
    code in 300..399 -> IngestResult.ClientError(texts.get(R.string.ingest_error_redirect, code))
    code in 200..299 -> try {
        IngestResult.Success(parseIngestResponse(body))
    } catch (_: Exception) {
        IngestResult.ClientError(texts.get(R.string.ingest_error_unparseable))
    }
    // タイムアウトと流量制限は時間をおけば通るので再試行する
    code == 408 || code == 429 -> IngestResult.Retryable(texts.get(R.string.ingest_error_busy, code))
    code in 400..499 ->
        IngestResult.ClientError(
            texts.get(R.string.ingest_error_client, code, parseErrorMessage(body) ?: texts.get(R.string.ingest_error_unknown)),
        )
    else -> IngestResult.Retryable(texts.get(R.string.ingest_error_server, code))
}

object IngestClient {
    private const val CONNECT_TIMEOUT_SECONDS = 30L
    // サーバーは受信のあとノートも書き込むので、応答を待つ時間は長めにする
    private const val READ_TIMEOUT_SECONDS = 120L
    private const val WRITE_TIMEOUT_SECONDS = 60L

    private val client = OkHttpClient.Builder()
        .followRedirects(false)
        .followSslRedirects(false)
        .connectTimeout(CONNECT_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .readTimeout(READ_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .writeTimeout(WRITE_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .build()

    private val JSON_TYPE = "application/json; charset=utf-8".toMediaType()

    // 通信はメインスレッドで行えない (NetworkOnMainThreadException) ので必ず IO スレッドで実行する
    suspend fun post(texts: Texts, serverUrl: String, token: String, days: List<DailySummary>): IngestResult =
        withContext(Dispatchers.IO) { postBlocking(texts, serverUrl, token, days) }

    private fun postBlocking(texts: Texts, serverUrl: String, token: String, days: List<DailySummary>): IngestResult {
        val base = serverUrl.trim().trimEnd('/')
        val url = "$base/api/ingest".toHttpUrlOrNull()
        if (url == null || url.scheme != "https") {
            return IngestResult.ClientError(texts.get(R.string.ingest_error_invalid_url))
        }
        val body = ingestJson.encodeToString(IngestRequest.serializer(), IngestRequest(days))
        val request = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer $token")
            .post(body.toRequestBody(JSON_TYPE))
            .build()
        return try {
            client.newCall(request).execute().use { res ->
                classifyIngestResponse(texts, res.code, res.body.string())
            }
        } catch (e: IOException) {
            IngestResult.Retryable(texts.get(R.string.ingest_error_network, e.message ?: e.javaClass.simpleName))
        }
    }
}
