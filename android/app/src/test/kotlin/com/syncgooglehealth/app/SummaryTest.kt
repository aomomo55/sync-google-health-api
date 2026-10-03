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
