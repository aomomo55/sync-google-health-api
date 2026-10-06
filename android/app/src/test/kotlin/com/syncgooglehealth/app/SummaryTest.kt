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
    fun omitsEmptyFieldsAndSections() {
        val day = DayAggregator.build(date, TOKYO, RawDay(steps = 1234), null)
        val json = encode(day)
        assertEquals(setOf("date", "activity", "source"), json.keys)
        assertEquals(setOf("steps"), json["activity"]!!.jsonObject.keys)
        assertEquals("health_connect", json["source"].toString().trim('"'))
    }

    @Test
    fun roundsToExpectedDigits() {
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
    fun hasDataIsFalseWhenNoData() {
        val day = DayAggregator.build(date, TOKYO, RawDay(), null)
        assertFalse(day.hasData())
        assertNull(day.activity)
        assertNull(day.heartRate)
        assertNull(day.body)
    }

    @Test
    fun clipsExerciseDurationToDayRange() {
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
    fun doesNotDoubleCountOverlappingExerciseSessions() {
        val raw = RawDay(
            exercise = listOf(
                ExerciseSpan(at(2026, 3, 5, 10), at(2026, 3, 5, 11), true),
                ExerciseSpan(at(2026, 3, 5, 10, 30), at(2026, 3, 5, 11, 30), false),
            ),
        )
        assertEquals(90L, DayAggregator.build(date, TOKYO, raw, null).activity!!.moveMinutes)
    }

    @Test
    fun omitsMoveFieldsWithoutExerciseSessions() {
        val raw = RawDay(steps = 1, exercise = listOf(ExerciseSpan(at(2026, 3, 7, 10), at(2026, 3, 7, 11), true)))
        val a = DayAggregator.build(date, TOKYO, raw, null).activity!!
        assertNull(a.moveMinutes)
        assertNull(a.walkingMinutes)
    }

    @Test
    fun omitsWalkingWhenOnlyNonWalkingExercise() {
        val raw = RawDay(exercise = listOf(ExerciseSpan(at(2026, 3, 5, 10), at(2026, 3, 5, 11), false)))
        val a = DayAggregator.build(date, TOKYO, raw, null).activity!!
        assertEquals(60L, a.moveMinutes)
        assertNull(a.walkingMinutes)
    }
}

class NutritionTest {
    private val date = LocalDate.of(2026, 3, 5)

    @Test
    fun roundsKcalToIntegerAndGramsToOneDecimal() {
        val raw = RawDay(energyKcal = 1999.5, proteinG = 60.04, fatG = 55.56, carbsG = 250.25)
        val n = DayAggregator.build(date, TOKYO, raw, null).nutrition!!
        assertEquals(2000L, n.energyKcal)
        assertEquals(60.0, n.proteinG!!, 0.0)
        assertEquals(55.6, n.fatG!!, 0.0)
        assertEquals(250.3, n.carbsG!!, 0.0)
    }

    @Test
    fun omitsMissingFieldsAndOutputsPartialData() {
        val day = DayAggregator.build(date, TOKYO, RawDay(energyKcal = 1800.0), null)
        val json = encode(day)
        assertEquals(setOf("date", "nutrition", "source"), json.keys)
        assertEquals(setOf("energy_kcal"), json["nutrition"]!!.jsonObject.keys)
        assertTrue(day.hasData())
    }

    @Test
    fun allFieldKeysAreExact() {
        val raw = RawDay(energyKcal = 1.0, proteinG = 2.0, fatG = 3.0, carbsG = 4.0)
        val keys = encode(DayAggregator.build(date, TOKYO, raw, null))["nutrition"]!!.jsonObject.keys
        assertEquals(setOf("energy_kcal", "protein_g", "fat_g", "carbs_g"), keys)
    }

    @Test
    fun omitsNutritionSectionWhenEmpty() {
        val day = DayAggregator.build(date, TOKYO, RawDay(steps = 10), null)
        assertNull(day.nutrition)
        assertFalse(encode(day).containsKey("nutrition"))
    }

    @Test
    fun keepsZeroAsValue() {
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
    fun requiredPermissionsExcludeNutrition() {
        assertEquals(setOf("android.permission.health.READ_STEPS", PermissionPolicy.READ_IN_BACKGROUND), PermissionPolicy.required(all, true))
        assertEquals(setOf("android.permission.health.READ_STEPS"), PermissionPolicy.required(all, false))
    }

    @Test
    fun readsNutritionOnlyWhenGranted() {
        assertTrue(PermissionPolicy.canReadNutrition(all))
        assertFalse(PermissionPolicy.canReadNutrition(all - PermissionPolicy.READ_NUTRITION))
    }
}

class SleepAssignerTest {
    private val nothing = "app.a"

    private fun stage(type: Int, s: Instant, e: Instant) = SleepStage(type, s, e)

    @Test
    fun assignsOvernightSleepToWakeDate() {
        val s = SleepSessionInput("a", at(2026, 3, 4, 22, 30), at(2026, 3, 5, 6, 30), emptyList())
        val map = SleepAssigner.assign(listOf(s), TOKYO)
        assertEquals(setOf(LocalDate.of(2026, 3, 5)), map.keys)
        val sl = map.getValue(LocalDate.of(2026, 3, 5))
        assertEquals("2026-03-04T22:30:00+09:00", sl.start)
        assertEquals("2026-03-05T06:30:00+09:00", sl.end)
    }

    @Test
    fun withoutStagesAsleepEqualsInBedAndOmitsBreakdown() {
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
    fun aggregatesStages() {
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
    fun prefersOriginWithStagesOverLongerOriginWithout() {
        val unstaged = SleepSessionInput("app.a", at(2026, 3, 5, 0), at(2026, 3, 5, 9), emptyList())
        val staged = SleepSessionInput(
            "app.b", at(2026, 3, 5, 1), at(2026, 3, 5, 6),
            listOf(stage(4, at(2026, 3, 5, 1), at(2026, 3, 5, 6))),
        )
        val sl = SleepAssigner.assign(listOf(unstaged, staged), TOKYO).values.single()
        assertEquals(300L, sl.inBedMinutes)
    }

    @Test
    fun picksLongerTotalAmongOriginsWithStages() {
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
    fun picksLexicographicallySmallestOriginIdOnTie() {
        val a = SleepSessionInput("app.a", at(2026, 3, 5, 0), at(2026, 3, 5, 5), emptyList())
        val b = SleepSessionInput("app.b", at(2026, 3, 5, 1), at(2026, 3, 5, 6), emptyList())
        for (list in listOf(listOf(a, b), listOf(b, a))) {
            val sl = SleepAssigner.assign(list, TOKYO).values.single()
            assertEquals("2026-03-05T00:00:00+09:00", sl.start)
        }
    }

    @Test
    fun picksOriginWithLongestTotalWhenNoStages() {
        val a = SleepSessionInput("app.a", at(2026, 3, 5, 0), at(2026, 3, 5, 5), emptyList())
        val b1 = SleepSessionInput("app.b", at(2026, 3, 5, 0), at(2026, 3, 5, 4), emptyList())
        val b2 = SleepSessionInput("app.b", at(2026, 3, 5, 13), at(2026, 3, 5, 15), emptyList())
        val sl = SleepAssigner.assign(listOf(a, b1, b2), TOKYO).values.single()
        // b の合計 6 時間 > a の 5 時間。主睡眠は b の最長 (4 時間)、昼寝 2 時間
        assertEquals(240L, sl.inBedMinutes)
        assertEquals(120L, sl.napMinutes)
    }

    @Test
    fun napIsAsleepTotalExcludingLongest() {
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
    fun assignsDifferentWakeDatesSeparately() {
        val d1 = SleepSessionInput("a", at(2026, 3, 4, 23), at(2026, 3, 5, 6), emptyList())
        val d2 = SleepSessionInput("a", at(2026, 3, 5, 23), at(2026, 3, 6, 6), emptyList())
        val map = SleepAssigner.assign(listOf(d1, d2), TOKYO)
        assertEquals(setOf(LocalDate.of(2026, 3, 5), LocalDate.of(2026, 3, 6)), map.keys)
    }

    @Test
    fun mergesSessionsWithinTwoHoursIntoOneNight() {
        val first = SleepSessionInput(
            "a", at(2026, 3, 4, 22, 50), at(2026, 3, 5, 2, 40),
            listOf(
                stage(4, at(2026, 3, 4, 22, 50), at(2026, 3, 5, 1)),     // light 130
                stage(5, at(2026, 3, 5, 1), at(2026, 3, 5, 2, 30)),      // deep 90
                stage(1, at(2026, 3, 5, 2, 30), at(2026, 3, 5, 2, 40)),  // awake 10
            ),
        )
        val second = SleepSessionInput(
            "a", at(2026, 3, 5, 3), at(2026, 3, 5, 6, 40),
            listOf(
                stage(4, at(2026, 3, 5, 3), at(2026, 3, 5, 5)),          // light 120
                stage(6, at(2026, 3, 5, 5), at(2026, 3, 5, 6, 40)),      // rem 100
            ),
        )
        val nap = SleepSessionInput("a", at(2026, 3, 5, 13), at(2026, 3, 5, 13, 30), emptyList())
        for (list in listOf(listOf(first, second, nap), listOf(nap, second, first))) {
            val sl = SleepAssigner.assign(list, TOKYO).values.single()
            assertEquals("2026-03-04T22:50:00+09:00", sl.start)
            assertEquals("2026-03-05T06:40:00+09:00", sl.end)
            assertEquals(470L, sl.inBedMinutes)
            // ステージの awake 10 分 + セッション間の 20 分
            assertEquals(30L, sl.awakeMinutes)
            assertEquals(440L, sl.asleepMinutes)
            assertEquals(90L, sl.deepMinutes)
            assertEquals(250L, sl.lightMinutes)
            assertEquals(100L, sl.remMinutes)
            // しきい値を超えて離れた昼寝は仮眠のまま
            assertEquals(30L, sl.napMinutes)
        }
    }

    @Test
    fun mergesAtExactThresholdAndTreatsBeyondAsNap() {
        val first = SleepSessionInput("a", at(2026, 3, 5, 0), at(2026, 3, 5, 2), emptyList())
        val joined = SleepSessionInput("a", at(2026, 3, 5, 4), at(2026, 3, 5, 7), emptyList())
        val sl = SleepAssigner.assign(listOf(first, joined), TOKYO).values.single()
        assertEquals(420L, sl.inBedMinutes)
        assertEquals(300L, sl.asleepMinutes)
        assertNull(sl.awakeMinutes)
        assertNull(sl.napMinutes)

        val apart = SleepSessionInput("a", at(2026, 3, 5, 4, 1), at(2026, 3, 5, 7), emptyList())
        val sl2 = SleepAssigner.assign(listOf(first, apart), TOKYO).values.single()
        assertEquals(179L, sl2.inBedMinutes)
        assertEquals(120L, sl2.napMinutes)
    }

    @Test
    fun assignsMergedCrossDaySleepToLastWakeDate() {
        val before = SleepSessionInput("a", at(2026, 3, 4, 21), at(2026, 3, 4, 23, 50), emptyList())
        val after = SleepSessionInput("a", at(2026, 3, 5, 0, 30), at(2026, 3, 5, 6), emptyList())
        val map = SleepAssigner.assign(listOf(before, after), TOKYO)
        assertEquals(setOf(LocalDate.of(2026, 3, 5)), map.keys)
        assertEquals("2026-03-04T21:00:00+09:00", map.getValue(LocalDate.of(2026, 3, 5)).start)
    }

    @Test
    fun doesNotMergeSessionsFromDifferentOrigins() {
        val a = SleepSessionInput("app.a", at(2026, 3, 5, 0), at(2026, 3, 5, 3), emptyList())
        val b = SleepSessionInput("app.b", at(2026, 3, 5, 3, 30), at(2026, 3, 5, 7), emptyList())
        val sl = SleepAssigner.assign(listOf(a, b), TOKYO).values.single()
        assertEquals("2026-03-05T03:30:00+09:00", sl.start)
        assertNull(sl.napMinutes)
    }

    @Test
    fun sleepJsonHasOnlyExactKeys() {
        val s = SleepSessionInput("a", at(2026, 3, 5, 0), at(2026, 3, 5, 7), emptyList())
        val sl = SleepAssigner.assign(listOf(s), TOKYO).values.single()
        val day = DayAggregator.build(LocalDate.of(2026, 3, 5), TOKYO, RawDay(), sl)
        val keys = encode(day)["sleep"]!!.jsonObject.keys
        assertEquals(setOf("start", "end", "asleep_minutes", "in_bed_minutes"), keys)
    }
}

class ChunkingTest {
    @Test
    fun splitsRangeInto30DayChunks() {
        val from = LocalDate.of(2026, 1, 1)
        val r = chunkRanges(from, from.plusDays(64))
        assertEquals(3, r.size)
        assertEquals(from to from.plusDays(29), r[0])
        assertEquals(from.plusDays(30) to from.plusDays(59), r[1])
        assertEquals(from.plusDays(60) to from.plusDays(64), r[2])
    }

    @Test
    fun exactly30DaysIsOneChunk() {
        val from = LocalDate.of(2026, 1, 1)
        assertEquals(1, chunkRanges(from, from.plusDays(29)).size)
        assertEquals(2, chunkRanges(from, from.plusDays(30)).size)
    }

    @Test
    fun emptyWhenDateIsBeforeFrom() {
        val d = LocalDate.of(2026, 1, 1)
        assertTrue(chunkRanges(d, d.minusDays(1)).isEmpty())
    }

    @Test
    fun requestUnitIsAtMost30() {
        val days = (1..65).map { DailySummary(date = LocalDate.of(2026, 1, 1).plusDays(it.toLong()).toString()) }
        val chunks = chunkDays(days)
        assertEquals(listOf(30, 30, 5), chunks.map { it.size })
    }
}

class IngestResponseTest {
    @Test
    fun withNotes() {
        val ok = parseIngestResponse("""{"written":3,"notes":{"written":2,"unchanged":1,"failed":[{"path":"a","error":"x"}]}}""")
        assertEquals(3, ok.written)
        assertEquals(NotesResult(2, 1, 1, null), ok.notes)
    }

    @Test
    fun notesErrorAndNull() {
        assertEquals("boom", parseIngestResponse("""{"written":1,"notes":{"error":"boom"}}""").notes!!.error)
        assertNull(parseIngestResponse("""{"written":1,"notes":null}""").notes)
    }

    @Test(expected = IllegalArgumentException::class)
    fun responseWithoutWrittenThrows() {
        parseIngestResponse("""{"notes":null}""")
    }

    @Test
    fun extractsErrorMessage() {
        assertEquals("bad", parseErrorMessage("""{"error":"bad"}"""))
        assertNull(parseErrorMessage("not json"))
    }

    @Test
    fun validatesControlCharactersInToken() {
        assertTrue(SettingsStore.isValidToken("abc123-_"))
        assertFalse(SettingsStore.isValidToken("abc\n"))
        assertFalse(SettingsStore.isValidToken(""))
    }
}

class IngestClassifyTest {
    @Test
    fun success() {
        val r = classifyIngestResponse(200, """{"written":2,"notes":null}""")
        assertEquals(IngestResult.Success(IngestOk(2, null)), r)
    }

    @Test
    fun twoXxWithoutWrittenIsError() {
        assertTrue(classifyIngestResponse(200, """{"ok":true}""") is IngestResult.ClientError)
        assertTrue(classifyIngestResponse(200, "<html></html>") is IngestResult.ClientError)
        assertTrue(classifyIngestResponse(204, "") is IngestResult.ClientError)
    }

    @Test
    fun redirectIsError() {
        for (code in listOf(301, 302, 307, 308)) {
            val r = classifyIngestResponse(code, "")
            assertTrue("$code", r is IngestResult.ClientError)
            assertTrue((r as IngestResult.ClientError).message.contains("リダイレクト"))
        }
    }

    @Test
    fun authError() {
        assertEquals(IngestResult.Unauthorized, classifyIngestResponse(401, """{"error":"unauthorized"}"""))
    }

    @Test
    fun retriesOnTimeoutAndRateLimit() {
        assertTrue(classifyIngestResponse(408, "") is IngestResult.Retryable)
        assertTrue(classifyIngestResponse(429, """{"error":"too many"}""") is IngestResult.Retryable)
    }

    @Test
    fun doesNotRetryOther4xx() {
        val r = classifyIngestResponse(400, """{"error":"bad"}""")
        assertEquals(IngestResult.ClientError("送信エラー (400): bad"), r)
        assertTrue(classifyIngestResponse(413, "") is IngestResult.ClientError)
    }

    @Test
    fun retriesOnServerError() {
        assertTrue(classifyIngestResponse(500, "") is IngestResult.Retryable)
        assertTrue(classifyIngestResponse(503, "") is IngestResult.Retryable)
    }
}

class StoredTokenTest {
    @Test
    fun returnsNullAndDiscardsNothingWhenNotStored() {
        val discarded = mutableListOf<String>()
        assertNull(readStoredToken(null, { it }, { discarded += it }))
        assertTrue(discarded.isEmpty())
    }

    @Test
    fun returnsTokenWhenDecryptable() {
        val discarded = mutableListOf<String>()
        assertEquals("tok", readStoredToken("enc", { "tok" }, { discarded += it }))
        assertTrue(discarded.isEmpty())
    }

    @Test
    fun discardsAndReturnsNullWhenNotDecryptable() {
        val discarded = mutableListOf<String>()
        assertNull(readStoredToken("enc", { throw javax.crypto.AEADBadTagException() }, { discarded += it }))
        assertTrue(discarded.isNotEmpty())
    }

    @Test
    fun discardsAndReturnsNullForEmptyToken() {
        val discarded = mutableListOf<String>()
        assertNull(readStoredToken("enc", { "" }, { discarded += it }))
        assertTrue(discarded.isNotEmpty())
    }

    @Test
    fun returnsUnavailableWithoutDiscardingOnTransientFailure() {
        val transient = listOf(
            java.security.KeyStoreException("busy"),
            java.security.ProviderException("keystore"),
            java.security.InvalidKeyException("init"),
            IllegalStateException("x"),
            RuntimeException("x"),
        )
        for (e in transient) {
            val discarded = mutableListOf<String>()
            val r = readStoredTokenState("enc", { throw e }, { discarded += it })
            assertEquals(e.toString(), StoredToken.Unavailable, r)
            assertTrue(e.toString(), discarded.isEmpty())
            assertNull(readStoredToken("enc", { throw e }, { discarded += it }))
            assertTrue(e.toString(), discarded.isEmpty())
        }
    }

    @Test
    fun discardsPassingReadCiphertextWhenDefinitelyUnusable() {
        val definitive = listOf(
            javax.crypto.AEADBadTagException(),
            java.security.UnrecoverableKeyException(),
            UnusableStoredTokenException("Base64 として不正です", IllegalArgumentException()),
            UnusableStoredTokenException("暗号文が短すぎます"),
        )
        for (e in definitive) {
            val discarded = mutableListOf<String>()
            val r = readStoredTokenState("enc", { throw e }, { discarded += it })
            assertEquals(e.toString(), StoredToken.None, r)
            assertEquals(e.toString(), listOf("enc"), discarded)
        }
    }

    @Test
    fun readsState() {
        assertEquals(StoredToken.None, readStoredTokenState(null, { it }, {}))
        assertEquals(StoredToken.Available("tok"), readStoredTokenState("enc", { "tok" }, {}))
        assertFalse(StoredToken.Available("secret-token").toString().contains("secret-token"))
    }

    @Test
    fun conditionalDiscardKeepsNewerValue() {
        val prefs = mutableMapOf("token" to "old")
        // 読んでから消すまでの間に新しいトークンが保存された
        prefs["token"] = "new"
        val removed = removeIfUnchanged({ prefs["token"] }, "old") { prefs.remove("token") }
        assertFalse(removed)
        assertEquals("new", prefs["token"])
    }

    @Test
    fun conditionalDiscardRemovesSameValue() {
        val prefs = mutableMapOf("token" to "old")
        assertTrue(removeIfUnchanged({ prefs["token"] }, "old") { prefs.remove("token") })
        assertNull(prefs["token"])
        // 既に無ければ何もしない
        assertFalse(removeIfUnchanged({ prefs["token"] }, "old") { prefs.remove("token") })
    }
}

class IngestRejectedTest {
    @Test
    fun readsRejected() {
        val ok = parseIngestResponse(
            """{"written":2,"notes":null,"rejected":[{"date":"2026-01-02","error":"歩数が範囲外です"}]}""",
        )
        assertEquals(2, ok.written)
        assertEquals(listOf(RejectedDay("2026-01-02", "歩数が範囲外です")), ok.rejected)
    }

    @Test
    fun emptyRejectedForOldServerWithoutIt() {
        assertEquals(emptyList<RejectedDay>(), parseIngestResponse("""{"written":2,"notes":null}""").rejected)
        assertEquals(emptyList<RejectedDay>(), parseIngestResponse("""{"written":2,"rejected":[]}""").rejected)
        assertEquals(emptyList<RejectedDay>(), parseIngestResponse("""{"written":2,"rejected":null}""").rejected)
    }

    @Test
    fun ignoresUnknownFields() {
        val ok = parseIngestResponse(
            """{"written":1,"extra":{"a":1},"rejected":[{"date":"2026-01-02","error":"x","extra":true}]}""",
        )
        assertEquals(listOf(RejectedDay("2026-01-02", "x")), ok.rejected)
    }

    @Test
    fun uninterpretableRejectedIsError() {
        assertTrue(classifyIngestResponse(200, """{"written":1,"rejected":"x"}""") is IngestResult.ClientError)
        assertTrue(classifyIngestResponse(200, """{"written":1,"rejected":[1]}""") is IngestResult.ClientError)
        assertTrue(classifyIngestResponse(200, """{"written":1,"rejected":[{"error":"x"}]}""") is IngestResult.ClientError)
    }

    @Test
    fun successEvenWithRejected() {
        val r = classifyIngestResponse(200, """{"written":1,"notes":null,"rejected":[{"date":"2026-01-03","error":"x"}]}""")
        assertEquals(IngestResult.Success(IngestOk(1, null, listOf(RejectedDay("2026-01-03", "x")))), r)
    }
}

class SyncMessageTest {
    private val notes = NotesResult(written = 2, unchanged = 1, failed = 0, error = null)

    @Test
    fun unchangedWhenNothingRejected() {
        val t = SyncTally().add(3, IngestOk(3, notes))
        assertEquals("3日分を送信しました / ノート 更新2・変更なし1・失敗0", buildSyncMessage(t, includeNutrition = true))
    }

    @Test
    fun nutritionAndNoteError() {
        val t = SyncTally().add(1, IngestOk(1, NotesResult(0, 0, 1, "boom")))
        assertEquals(
            "1日分を送信しました（栄養は権限が無いため送っていません） / ノート 更新0・変更なし0・失敗1 / ノートエラー: boom",
            buildSyncMessage(t, includeNutrition = false),
        )
    }

    @Test
    fun collectsRejectedDaysAcrossChunks() {
        val t = SyncTally()
            .add(30, IngestOk(29, notes, listOf(RejectedDay("2026-01-05", "歩数が範囲外です"))))
            .add(5, IngestOk(4, null, listOf(RejectedDay("2026-01-02", "歩数が範囲外です"))))
        assertEquals(35, t.sent)
        assertEquals(
            "35日分を送信しました（2日分は値が範囲外のため保存されませんでした: 2026-01-02, 2026-01-05 / 理由: 歩数が範囲外です） " +
                "/ ノート 更新2・変更なし1・失敗0",
            buildSyncMessage(t, includeNutrition = true),
        )
    }

    @Test
    fun truncatesWhenManyRejected() {
        val rejected = (1..7).map { RejectedDay("2026-01-0$it", "理由$it") }
        val t = SyncTally().add(7, IngestOk(0, null, rejected))
        val msg = buildSyncMessage(t, includeNutrition = true)
        assertTrue(msg, msg.contains("7日分は値が範囲外のため保存されませんでした: 2026-01-01, 2026-01-02, 2026-01-03, 2026-01-04, 2026-01-05 ほか2日"))
        assertTrue(msg, msg.contains("理由: 理由1、理由2 ほか）"))
        assertFalse(msg, msg.contains("2026-01-06"))
    }

    @Test
    fun truncatesLongReason() {
        val long = "あ".repeat(100)
        val t = SyncTally().add(1, IngestOk(0, null, listOf(RejectedDay("2026-01-01", long))))
        val msg = buildSyncMessage(t, includeNutrition = true)
        assertTrue(msg, msg.contains("あ".repeat(40) + "…）"))
        assertFalse(msg, msg.contains("あ".repeat(41)))
    }
}

class SyncRangeTest {
    private val today = LocalDate.of(2026, 10, 6)

    @Test
    fun earliestSelectableStartIs90DaysBack() {
        assertEquals(LocalDate.of(2026, 7, 8), earliestSelectableStart(today))
    }

    @Test
    fun selectableStartIsBetweenEarliestAndToday() {
        assertTrue(isSelectableStart(LocalDate.of(2026, 7, 8), today))
        assertTrue(isSelectableStart(today, today))
        assertFalse(isSelectableStart(LocalDate.of(2026, 7, 7), today))
        assertFalse(isSelectableStart(today.plusDays(1), today))
    }

    @Test
    fun historyPermissionIsNeededOnlyBeyond30Days() {
        assertFalse(needsHistoryPermission(today.minusDays(30), today))
        assertTrue(needsHistoryPermission(today.minusDays(31), today))
    }

    @Test
    fun countsDaysInclusively() {
        assertEquals(1, countDays(today, today))
        assertEquals(61, countDays(today.minusDays(60), today))
    }

    @Test
    fun formatsProgressPerChunk() {
        val from = LocalDate.of(2026, 8, 1)
        val to = from.plusDays(59)
        val (s, e) = chunkRanges(from, to).first()
        assertEquals("2026-08-01〜2026-08-30 を送信済み（30/60 日）", formatProgress(from, to, s, e))
        val (s2, e2) = chunkRanges(from, to).last()
        assertEquals("2026-08-31〜2026-09-29 を送信済み（60/60 日）", formatProgress(from, to, s2, e2))
    }

    @Test
    fun chunksOf90DaysMakeThreeRequests() {
        assertEquals(3, chunkRanges(today.minusDays(89), today).size)
    }

    @Test
    fun historyPermissionIsOptional() {
        val all = setOf("android.permission.health.READ_STEPS", PermissionPolicy.READ_HISTORY)
        assertEquals(setOf("android.permission.health.READ_STEPS"), PermissionPolicy.required(all, false))
        assertTrue(PermissionPolicy.canReadHistory(all))
        assertFalse(PermissionPolicy.canReadHistory(all - PermissionPolicy.READ_HISTORY))
    }

    @Test
    fun unreadableItemsAreOmittedNotNull() {
        // 読めなかった項目は RawDay の既定値 (null) のままで、送信 JSON にはキーごと出ない
        val day = DayAggregator.build(LocalDate.of(2026, 8, 1), TOKYO, RawDay(steps = 100), null)
        val json = encode(day)
        assertEquals(setOf("date", "activity", "source"), json.keys)
        assertEquals(setOf("steps"), json["activity"]!!.jsonObject.keys)
    }
}
