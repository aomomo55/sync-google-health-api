package com.syncgooglehealth.app

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZonedDateTime

private val TOKYO = ZoneId.of("Asia/Tokyo")
private fun at(y: Int, m: Int, d: Int, h: Int, min: Int = 0): Instant =
    ZonedDateTime.of(y, m, d, h, min, 0, 0, TOKYO).toInstant()

private fun encode(day: DailySummary): JsonObject =
    Json.parseToJsonElement(ingestJson.encodeToString(DailySummary.serializer(), day)).jsonObject

class DayAggregatorTest {
    private val date = LocalDate.of(2026, 3, 5)

    @Test
    fun 値が無い項目とセクションは出力しない() {
        val day = DayAggregator.build(date, TOKYO, RawDay(steps = 1234), null)
        val json = encode(day)
        assertEquals(setOf("date", "activity", "source"), json.keys)
        assertEquals(setOf("steps"), json["activity"]!!.jsonObject.keys)
        assertEquals("health_connect", json["source"].toString().trim('"'))
    }

    @Test
    fun 丸め桁数() {
        val raw = RawDay(
            distanceM = 1234.56, caloriesKcal = 2000.04, hrAvg = 70.26,
            weightKg = 65.456, bodyFatPct = 18.25,
        )
        val day = DayAggregator.build(date, TOKYO, raw, null)
        assertEquals(1234.6, day.activity!!.distanceM!!, 0.0)
        assertEquals(2000.0, day.activity!!.caloriesKcal!!, 0.0)
        assertEquals(70.3, day.heartRate!!.avgBpm!!, 0.0)
        assertEquals(65.46, day.body!!.weightKg!!, 0.0)
        assertEquals(18.3, day.body!!.bodyFatPct!!, 0.0)
    }

    @Test
    fun データが全く無い日はhasDataがfalse() {
        val day = DayAggregator.build(date, TOKYO, RawDay(), null)
        assertFalse(day.hasData())
        assertNull(day.activity)
        assertNull(day.heartRate)
        assertNull(day.body)
    }

    @Test
    fun 運動時間は日の範囲にクリップされる() {
        val raw = RawDay(
            exercise = listOf(
                // 前日 23:30 - 当日 00:30 → 当日分は 30 分 (ウォーキング)
                ExerciseSpan(at(2026, 3, 4, 23, 30), at(2026, 3, 5, 0, 30), true),
                // 当日 10:00 - 11:00 (ランニング)
                ExerciseSpan(at(2026, 3, 5, 10), at(2026, 3, 5, 11), false),
                // 当日 23:30 - 翌日 01:00 → 当日分は 30 分
                ExerciseSpan(at(2026, 3, 5, 23, 30), at(2026, 3, 6, 1), false),
            ),
        )
        val a = DayAggregator.build(date, TOKYO, raw, null).activity!!
        assertEquals(120L, a.moveMinutes)
        assertEquals(30L, a.walkingMinutes)
    }

    @Test
    fun 重なる運動セッションは二重に数えない() {
        val raw = RawDay(
            exercise = listOf(
                ExerciseSpan(at(2026, 3, 5, 10), at(2026, 3, 5, 11), true),
                ExerciseSpan(at(2026, 3, 5, 10, 30), at(2026, 3, 5, 11, 30), false),
            ),
        )
        assertEquals(90L, DayAggregator.build(date, TOKYO, raw, null).activity!!.moveMinutes)
    }

    @Test
    fun 運動セッションが無ければmove系は省略() {
        val raw = RawDay(steps = 1, exercise = listOf(ExerciseSpan(at(2026, 3, 7, 10), at(2026, 3, 7, 11), true)))
        val a = DayAggregator.build(date, TOKYO, raw, null).activity!!
        assertNull(a.moveMinutes)
        assertNull(a.walkingMinutes)
    }

    @Test
    fun ウォーキング以外だけならwalkingは省略() {
        val raw = RawDay(exercise = listOf(ExerciseSpan(at(2026, 3, 5, 10), at(2026, 3, 5, 11), false)))
        val a = DayAggregator.build(date, TOKYO, raw, null).activity!!
        assertEquals(60L, a.moveMinutes)
        assertNull(a.walkingMinutes)
    }
}

class NutritionTest {
    private val date = LocalDate.of(2026, 3, 5)

    @Test
    fun 丸め_kcalは整数でグラムは小数1桁() {
        val raw = RawDay(energyKcal = 1999.5, proteinG = 60.04, fatG = 55.56, carbsG = 250.25)
        val n = DayAggregator.build(date, TOKYO, raw, null).nutrition!!
        assertEquals(2000L, n.energyKcal)
        assertEquals(60.0, n.proteinG!!, 0.0)
        assertEquals(55.6, n.fatG!!, 0.0)
        assertEquals(250.3, n.carbsG!!, 0.0)
    }

    @Test
    fun データの無い項目は省略し部分的でも出力する() {
        val day = DayAggregator.build(date, TOKYO, RawDay(energyKcal = 1800.0), null)
        val json = encode(day)
        assertEquals(setOf("date", "nutrition", "source"), json.keys)
        assertEquals(setOf("energy_kcal"), json["nutrition"]!!.jsonObject.keys)
        assertTrue(day.hasData())
    }

    @Test
    fun 全項目のキーは厳密() {
        val raw = RawDay(energyKcal = 1.0, proteinG = 2.0, fatG = 3.0, carbsG = 4.0)
        val keys = encode(DayAggregator.build(date, TOKYO, raw, null))["nutrition"]!!.jsonObject.keys
        assertEquals(setOf("energy_kcal", "protein_g", "fat_g", "carbs_g"), keys)
    }

    @Test
    fun 栄養が空ならセクションごと省略() {
        val day = DayAggregator.build(date, TOKYO, RawDay(steps = 10), null)
        assertNull(day.nutrition)
        assertFalse(encode(day).containsKey("nutrition"))
    }

    @Test
    fun ゼロは値として残す() {
        val n = DayAggregator.build(date, TOKYO, RawDay(energyKcal = 0.0, proteinG = 0.0), null).nutrition!!
        assertEquals(0L, n.energyKcal)
        assertEquals(0.0, n.proteinG!!, 0.0)
    }
}

class PermissionPolicyTest {
    private val all = setOf(
        "android.permission.health.READ_STEPS",
        PermissionPolicy.READ_NUTRITION,
        PermissionPolicy.READ_IN_BACKGROUND,
    )

    @Test
    fun 必須権限に栄養を含めない() {
        assertEquals(setOf("android.permission.health.READ_STEPS", PermissionPolicy.READ_IN_BACKGROUND), PermissionPolicy.required(all, true))
        assertEquals(setOf("android.permission.health.READ_STEPS"), PermissionPolicy.required(all, false))
    }

    @Test
    fun 栄養は付与されているときだけ読む() {
        assertTrue(PermissionPolicy.canReadNutrition(all))
        assertFalse(PermissionPolicy.canReadNutrition(all - PermissionPolicy.READ_NUTRITION))
    }
}

class SleepAssignerTest {
    private val nothing = "app.a"

    private fun stage(type: Int, s: Instant, e: Instant) = SleepStage(type, s, e)

    @Test
    fun 日付をまたぐ睡眠は起床日に割り当てる() {
        val s = SleepSessionInput("a", at(2026, 3, 4, 22, 30), at(2026, 3, 5, 6, 30), emptyList())
        val map = SleepAssigner.assign(listOf(s), TOKYO)
        assertEquals(setOf(LocalDate.of(2026, 3, 5)), map.keys)
        val sl = map.getValue(LocalDate.of(2026, 3, 5))
        assertEquals("2026-03-04T22:30:00+09:00", sl.start)
        assertEquals("2026-03-05T06:30:00+09:00", sl.end)
    }

    @Test
    fun ステージ無しはasleepがinBedで内訳は省略() {
        val s = SleepSessionInput("a", at(2026, 3, 5, 0), at(2026, 3, 5, 7), emptyList())
        val sl = SleepAssigner.assign(listOf(s), TOKYO).values.single()
        assertEquals(420L, sl.inBedMinutes)
        assertEquals(420L, sl.asleepMinutes)
        assertNull(sl.awakeMinutes)
        assertNull(sl.deepMinutes)
        assertNull(sl.lightMinutes)
        assertNull(sl.remMinutes)
        assertNull(sl.napMinutes)
    }

    @Test
    fun ステージの集計() {
        val st = listOf(
            stage(4, at(2026, 3, 5, 0), at(2026, 3, 5, 2)),       // light 120
            stage(5, at(2026, 3, 5, 2), at(2026, 3, 5, 3)),       // deep 60
            stage(1, at(2026, 3, 5, 3), at(2026, 3, 5, 3, 10)),   // awake 10
            stage(6, at(2026, 3, 5, 3, 10), at(2026, 3, 5, 4)),   // rem 50
            stage(3, at(2026, 3, 5, 4), at(2026, 3, 5, 4, 5)),    // out of bed 5
            stage(7, at(2026, 3, 5, 4, 5), at(2026, 3, 5, 4, 10)),// awake in bed 5
            stage(2, at(2026, 3, 5, 4, 10), at(2026, 3, 5, 5)),   // sleeping 50 (未分類の睡眠)
        )
        val s = SleepSessionInput("a", at(2026, 3, 5, 0), at(2026, 3, 5, 5), st)
        val sl = SleepAssigner.assign(listOf(s), TOKYO).values.single()
        assertEquals(300L, sl.inBedMinutes)
        assertEquals(20L, sl.awakeMinutes)
        assertEquals(280L, sl.asleepMinutes)
        assertEquals(60L, sl.deepMinutes)
        assertEquals(120L, sl.lightMinutes)
        assertEquals(50L, sl.remMinutes)
    }

    @Test
    fun ステージ付きの起源は長いステージ無しの起源より優先() {
        val unstaged = SleepSessionInput("app.a", at(2026, 3, 5, 0), at(2026, 3, 5, 9), emptyList())
        val staged = SleepSessionInput(
            "app.b", at(2026, 3, 5, 1), at(2026, 3, 5, 6),
            listOf(stage(4, at(2026, 3, 5, 1), at(2026, 3, 5, 6))),
        )
        val sl = SleepAssigner.assign(listOf(unstaged, staged), TOKYO).values.single()
        assertEquals(300L, sl.inBedMinutes)
    }

    @Test
    fun ステージ付きの起源が複数なら合計が長い方() {
        val a = SleepSessionInput(
            "app.a", at(2026, 3, 5, 1), at(2026, 3, 5, 4),
            listOf(stage(5, at(2026, 3, 5, 1), at(2026, 3, 5, 4))),
        )
        val b = SleepSessionInput(
            "app.b", at(2026, 3, 5, 0), at(2026, 3, 5, 6),
            listOf(stage(6, at(2026, 3, 5, 0), at(2026, 3, 5, 6))),
        )
        val sl = SleepAssigner.assign(listOf(a, b), TOKYO).values.single()
        assertEquals(360L, sl.inBedMinutes)
    }

    @Test
    fun 同点なら起源idの辞書順で最小を選ぶ() {
        val a = SleepSessionInput("app.a", at(2026, 3, 5, 0), at(2026, 3, 5, 5), emptyList())
        val b = SleepSessionInput("app.b", at(2026, 3, 5, 1), at(2026, 3, 5, 6), emptyList())
        for (list in listOf(listOf(a, b), listOf(b, a))) {
            val sl = SleepAssigner.assign(list, TOKYO).values.single()
            assertEquals("2026-03-05T00:00:00+09:00", sl.start)
        }
    }

    @Test
    fun ステージが無ければ合計が最長の起源() {
        val a = SleepSessionInput("app.a", at(2026, 3, 5, 0), at(2026, 3, 5, 5), emptyList())
        val b1 = SleepSessionInput("app.b", at(2026, 3, 5, 0), at(2026, 3, 5, 4), emptyList())
        val b2 = SleepSessionInput("app.b", at(2026, 3, 5, 13), at(2026, 3, 5, 15), emptyList())
        val sl = SleepAssigner.assign(listOf(a, b1, b2), TOKYO).values.single()
        // b の合計 6 時間 > a の 5 時間。主睡眠は b の最長 (4 時間)、昼寝 2 時間
        assertEquals(240L, sl.inBedMinutes)
        assertEquals(120L, sl.napMinutes)
    }

    @Test
    fun 昼寝は最長以外のasleep合計() {
        val main = SleepSessionInput(nothing, at(2026, 3, 5, 0), at(2026, 3, 5, 7), emptyList())
        val nap1 = SleepSessionInput(
            nothing, at(2026, 3, 5, 13), at(2026, 3, 5, 14),
            listOf(stage(1, at(2026, 3, 5, 13), at(2026, 3, 5, 13, 10)), stage(4, at(2026, 3, 5, 13, 10), at(2026, 3, 5, 14))),
        )
        val nap2 = SleepSessionInput(nothing, at(2026, 3, 5, 16), at(2026, 3, 5, 16, 30), emptyList())
        val sl = SleepAssigner.assign(listOf(nap1, main, nap2), TOKYO).values.single()
        assertEquals(420L, sl.inBedMinutes)
        assertEquals(50L + 30L, sl.napMinutes)
    }

    @Test
    fun 別の起床日は別々に割り当てる() {
        val d1 = SleepSessionInput("a", at(2026, 3, 4, 23), at(2026, 3, 5, 6), emptyList())
        val d2 = SleepSessionInput("a", at(2026, 3, 5, 23), at(2026, 3, 6, 6), emptyList())
        val map = SleepAssigner.assign(listOf(d1, d2), TOKYO)
        assertEquals(setOf(LocalDate.of(2026, 3, 5), LocalDate.of(2026, 3, 6)), map.keys)
    }

    @Test
    fun 睡眠JSONは厳密なキーだけ() {
        val s = SleepSessionInput("a", at(2026, 3, 5, 0), at(2026, 3, 5, 7), emptyList())
        val sl = SleepAssigner.assign(listOf(s), TOKYO).values.single()
        val day = DayAggregator.build(LocalDate.of(2026, 3, 5), TOKYO, RawDay(), sl)
        val keys = encode(day)["sleep"]!!.jsonObject.keys
        assertEquals(setOf("start", "end", "asleep_minutes", "in_bed_minutes"), keys)
    }
}

class ChunkingTest {
    @Test
    fun 範囲を30日ずつに分割() {
        val from = LocalDate.of(2026, 1, 1)
        val r = chunkRanges(from, from.plusDays(64))
        assertEquals(3, r.size)
        assertEquals(from to from.plusDays(29), r[0])
        assertEquals(from.plusDays(30) to from.plusDays(59), r[1])
        assertEquals(from.plusDays(60) to from.plusDays(64), r[2])
    }

    @Test
    fun ちょうど30日なら1チャンク() {
        val from = LocalDate.of(2026, 1, 1)
        assertEquals(1, chunkRanges(from, from.plusDays(29)).size)
        assertEquals(2, chunkRanges(from, from.plusDays(30)).size)
    }

    @Test
    fun 日付がfromより前なら空() {
        val d = LocalDate.of(2026, 1, 1)
        assertTrue(chunkRanges(d, d.minusDays(1)).isEmpty())
    }

    @Test
    fun リクエスト単位は30件以下() {
        val days = (1..65).map { DailySummary(date = LocalDate.of(2026, 1, 1).plusDays(it.toLong()).toString()) }
        val chunks = chunkDays(days)
        assertEquals(listOf(30, 30, 5), chunks.map { it.size })
    }
}

class IngestResponseTest {
    @Test
    fun notesあり() {
        val ok = parseIngestResponse("""{"written":3,"notes":{"written":2,"unchanged":1,"failed":[{"path":"a","error":"x"}]}}""")
        assertEquals(3, ok.written)
        assertEquals(NotesResult(2, 1, 1, null), ok.notes)
    }

    @Test
    fun notesエラーとnull() {
        assertEquals("boom", parseIngestResponse("""{"written":1,"notes":{"error":"boom"}}""").notes!!.error)
        assertNull(parseIngestResponse("""{"written":1,"notes":null}""").notes)
    }

    @Test(expected = IllegalArgumentException::class)
    fun writtenが無い応答は例外() {
        parseIngestResponse("""{"notes":null}""")
    }

    @Test
    fun エラーメッセージ抽出() {
        assertEquals("bad", parseErrorMessage("""{"error":"bad"}"""))
        assertNull(parseErrorMessage("not json"))
    }

    @Test
    fun トークンの制御文字検証() {
        assertTrue(SettingsStore.isValidToken("abc123-_"))
        assertFalse(SettingsStore.isValidToken("abc\n"))
        assertFalse(SettingsStore.isValidToken(""))
    }
}

class IngestClassifyTest {
    @Test
    fun 成功() {
        val r = classifyIngestResponse(200, """{"written":2,"notes":null}""")
        assertEquals(IngestResult.Success(IngestOk(2, null)), r)
    }

    @Test
    fun writtenが無い2xxはエラー() {
        assertTrue(classifyIngestResponse(200, """{"ok":true}""") is IngestResult.ClientError)
        assertTrue(classifyIngestResponse(200, "<html></html>") is IngestResult.ClientError)
        assertTrue(classifyIngestResponse(204, "") is IngestResult.ClientError)
    }

    @Test
    fun リダイレクトはエラー() {
        for (code in listOf(301, 302, 307, 308)) {
            val r = classifyIngestResponse(code, "")
            assertTrue("$code", r is IngestResult.ClientError)
            assertTrue((r as IngestResult.ClientError).message.contains("リダイレクト"))
        }
    }

    @Test
    fun 認証エラー() {
        assertEquals(IngestResult.Unauthorized, classifyIngestResponse(401, """{"error":"unauthorized"}"""))
    }

    @Test
    fun タイムアウトと流量制限は再試行() {
        assertTrue(classifyIngestResponse(408, "") is IngestResult.Retryable)
        assertTrue(classifyIngestResponse(429, """{"error":"too many"}""") is IngestResult.Retryable)
    }

    @Test
    fun その他の4xxは再試行しない() {
        val r = classifyIngestResponse(400, """{"error":"bad"}""")
        assertEquals(IngestResult.ClientError("送信エラー (400): bad"), r)
        assertTrue(classifyIngestResponse(413, "") is IngestResult.ClientError)
    }

    @Test
    fun サーバーエラーは再試行() {
        assertTrue(classifyIngestResponse(500, "") is IngestResult.Retryable)
        assertTrue(classifyIngestResponse(503, "") is IngestResult.Retryable)
    }
}

class StoredTokenTest {
    @Test
    fun 未保存ならnullで何も消さない() {
        var discarded = false
        assertNull(readStoredToken(null, { it }, { discarded = true }))
        assertFalse(discarded)
    }

    @Test
    fun 復号できればそのまま返す() {
        var discarded = false
        assertEquals("tok", readStoredToken("enc", { "tok" }, { discarded = true }))
        assertFalse(discarded)
    }

    @Test
    fun 復号できなければ消してnull() {
        var discarded = false
        assertNull(readStoredToken("enc", { throw javax.crypto.AEADBadTagException() }, { discarded = true }))
        assertTrue(discarded)
    }

    @Test
    fun 空のトークンも消してnull() {
        var discarded = false
        assertNull(readStoredToken("enc", { "" }, { discarded = true }))
        assertTrue(discarded)
    }

    @Test
    fun 一時的な失敗では消さずにUnavailable() {
        val transient = listOf(
            java.security.KeyStoreException("busy"),
            java.security.ProviderException("keystore"),
            java.security.InvalidKeyException("init"),
            IllegalStateException("x"),
            RuntimeException("x"),
        )
        for (e in transient) {
            var discarded: String? = null
            val r = readStoredTokenState("enc", { throw e }, { discarded = it })
            assertEquals(e.toString(), StoredToken.Unavailable, r)
            assertNull(e.toString(), discarded)
            assertNull(readStoredToken("enc", { throw e }, { discarded = it }))
            assertNull(e.toString(), discarded)
        }
    }

    @Test
    fun 確実に使えないときは読んだ暗号文を渡して消す() {
        val definitive = listOf(
            javax.crypto.AEADBadTagException(),
            java.security.UnrecoverableKeyException(),
            UnusableStoredTokenException("Base64 として不正です", IllegalArgumentException()),
            UnusableStoredTokenException("暗号文が短すぎます"),
        )
        for (e in definitive) {
            var discarded: String? = null
            val r = readStoredTokenState("enc", { throw e }, { discarded = it })
            assertEquals(e.toString(), StoredToken.None, r)
            assertEquals(e.toString(), "enc", discarded)
        }
    }

    @Test
    fun 状態の読み出し() {
        assertEquals(StoredToken.None, readStoredTokenState(null, { it }, {}))
        assertEquals(StoredToken.Available("tok"), readStoredTokenState("enc", { "tok" }, {}))
        assertFalse(StoredToken.Available("secret-token").toString().contains("secret-token"))
    }

    @Test
    fun 条件付きの削除は新しい値を消さない() {
        val prefs = mutableMapOf("token" to "old")
        // 読んでから消すまでの間に新しいトークンが保存された
        prefs["token"] = "new"
        val removed = removeIfUnchanged({ prefs["token"] }, "old") { prefs.remove("token") }
        assertFalse(removed)
        assertEquals("new", prefs["token"])
    }

    @Test
    fun 条件付きの削除は同じ値なら消す() {
        val prefs = mutableMapOf("token" to "old")
        assertTrue(removeIfUnchanged({ prefs["token"] }, "old") { prefs.remove("token") })
        assertNull(prefs["token"])
        // 既に無ければ何もしない
        assertFalse(removeIfUnchanged({ prefs["token"] }, "old") { prefs.remove("token") })
    }
}
