package com.syncgooglehealth.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate
import java.time.LocalDateTime

class MissingSleepCheckTest {
    private val today = LocalDate.of(2026, 1, 10)
    private fun at(hour: Int, minute: Int = 0) = today.atTime(hour, minute)
    private fun action(
        now: LocalDateTime,
        hasTodaySleep: Boolean = false,
        background: Boolean = true,
        lastNotified: LocalDate? = null,
    ) = missingSleepAction(now, hasTodaySleep, background, lastNotified)

    private val sleep = SleepSummary(start = "2026-01-09T23:00:00+09:00", end = "2026-01-10T06:00:00+09:00", asleepMinutes = 400, inBedMinutes = 420)

    @Test
    fun hasSleepOnLooksOnlyAtTheGivenDate() {
        val days = listOf(
            DailySummary(date = "2026-01-09", sleep = sleep),
            DailySummary(date = "2026-01-10"),
        )
        assertFalse(hasSleepOn(days, today))
        assertTrue(hasSleepOn(days, today.minusDays(1)))
        assertTrue(hasSleepOn(days + DailySummary(date = "2026-01-10", sleep = sleep), today))
    }

    @Test
    fun notifiesInsideTheWindowWhenSleepIsMissing() {
        assertEquals(MissingSleepAction.NOTIFY, action(at(MISSING_SLEEP_CHECK_START_HOUR)))
        assertEquals(MissingSleepAction.NOTIFY, action(at(MISSING_SLEEP_CHECK_END_HOUR - 1, 59)))
    }

    @Test
    fun doesNothingOutsideTheWindow() {
        assertEquals(MissingSleepAction.NONE, action(at(MISSING_SLEEP_CHECK_START_HOUR - 1, 59)))
        assertEquals(MissingSleepAction.NONE, action(at(MISSING_SLEEP_CHECK_END_HOUR)))
        assertEquals(MissingSleepAction.NONE, action(at(2)))
    }

    @Test
    fun notifiesAtMostOncePerDay() {
        assertEquals(MissingSleepAction.NONE, action(at(8), lastNotified = today))
        assertEquals(MissingSleepAction.NOTIFY, action(at(8), lastNotified = today.minusDays(1)))
    }

    @Test
    fun doesNotNotifyOnManualSync() {
        assertEquals(MissingSleepAction.NONE, action(at(8), background = false))
    }

    @Test
    fun cancelsOnceSleepArrivesEvenOnManualSyncOrOutsideTheWindow() {
        assertEquals(MissingSleepAction.CANCEL, action(at(8), hasTodaySleep = true))
        assertEquals(MissingSleepAction.CANCEL, action(at(13), hasTodaySleep = true, background = false))
    }
}
