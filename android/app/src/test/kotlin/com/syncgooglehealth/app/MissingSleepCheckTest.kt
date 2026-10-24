package com.syncgooglehealth.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime

class MissingSleepCheckTest {
    private val today = LocalDate.of(2026, 1, 10)
    private val window = SleepCheckWindow(8, 12)
    private fun at(hour: Int, minute: Int = 0) = today.atTime(hour, minute)
    private fun action(
        now: LocalDateTime,
        hasTodaySleep: Boolean = false,
        background: Boolean = true,
        lastNotified: LocalDate? = null,
        showing: Boolean = lastNotified != null,
        window: SleepCheckWindow = this.window,
    ) = missingSleepAction(now, hasTodaySleep, background, lastNotified, showing, window)

    private val sleep = SleepSummary(
        start = "2026-01-09T23:00:00+09:00",
        end = "2026-01-10T07:00:00+09:00",
        asleepMinutes = 440,
        inBedMinutes = 480,
    )

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
        assertEquals(MissingSleepAction.NOTIFY, action(at(8)))
        assertEquals(MissingSleepAction.NOTIFY, action(at(11, 59)))
    }

    @Test
    fun doesNothingOutsideTheWindow() {
        assertEquals(MissingSleepAction.NONE, action(at(7, 59)))
        assertEquals(MissingSleepAction.NONE, action(at(12)))
        assertEquals(MissingSleepAction.NONE, action(at(2)))
    }

    @Test
    fun followsTheConfiguredWindow() {
        val late = SleepCheckWindow(10, 14)
        assertEquals(MissingSleepAction.NONE, action(at(8), window = late))
        assertEquals(MissingSleepAction.NOTIFY, action(at(13), window = late))
    }

    @Test
    fun rechecksOnEveryRunInsideTheWindowWhileTheNoticeIsShowing() {
        // 時間帯の開始 (8 時) より遅く起きた日: 起きる前の 8 時に出した通知を、起きた後の送信で確かめ直して出し直す
        assertEquals(MissingSleepAction.NOTIFY, action(at(10, 30), lastNotified = today, showing = true))
        assertEquals(MissingSleepAction.NOTIFY, action(at(9), lastNotified = today.minusDays(1), showing = false))
    }

    @Test
    fun doesNotNotifyAgainAfterTheUserDismissedTodaysNotice() {
        assertEquals(MissingSleepAction.NONE, action(at(9), lastNotified = today, showing = false))
        assertEquals(MissingSleepAction.NONE, action(at(11), lastNotified = today, showing = false))
    }

    @Test
    fun lateRiserGetsTheNoticeAfterWakingWhenSleepIsStillMissing() {
        // 8 時 (寝ている): まだ無いので通知。10 時台 (起きた後): まだ無ければ出したまま確かめ直す。届いたら消す
        assertEquals(MissingSleepAction.NOTIFY, action(at(8, 5)))
        assertEquals(MissingSleepAction.NOTIFY, action(at(10, 40), lastNotified = today, showing = true))
        assertEquals(MissingSleepAction.CANCEL, action(at(11, 10), hasTodaySleep = true, lastNotified = today, showing = true))
    }

    @Test
    fun noticeShowsWhenItWasChecked() {
        val notice = missingSleepNotice(LocalTime.of(8, 5))
        assertEquals("昨夜の睡眠がまだ届いていません", notice.title)
        assertTrue(notice.text.contains("8:05 に確認"))
        assertTrue(notice.detail.startsWith("8:05 の自動送信の時点で"))
        assertTrue(notice.detail.contains("ウェアラブルのアプリ"))
    }

    @Test
    fun doesNotNotifyOnManualSync() {
        assertEquals(MissingSleepAction.NONE, action(at(9), background = false))
    }

    @Test
    fun cancelsOnceSleepArrivesEvenOnManualSyncOrOutsideTheWindow() {
        assertEquals(MissingSleepAction.CANCEL, action(at(9), hasTodaySleep = true))
        assertEquals(MissingSleepAction.CANCEL, action(at(13), hasTodaySleep = true, background = false))
    }

    @Test
    fun cancelsYesterdaysNotificationOutsideTheWindow() {
        // 前日に通知し、睡眠が届かないまま日付が変わった
        assertEquals(MissingSleepAction.CANCEL, action(at(1), lastNotified = today.minusDays(1)))
        assertEquals(MissingSleepAction.CANCEL, action(at(13), background = false, lastNotified = today.minusDays(1)))
        // 今日の通知は時間帯の外でも消さない
        assertEquals(MissingSleepAction.NONE, action(at(13), lastNotified = today))
    }

    @Test
    fun parsesAndValidatesTheWindow() {
        assertEquals(SleepCheckWindow(7, 11), SleepCheckWindow.parse(" 7 ", "11"))
        assertEquals(SleepCheckWindow(0, 24), SleepCheckWindow.parse("0", "24"))
        assertNull(SleepCheckWindow.parse("11", "7"))
        assertNull(SleepCheckWindow.parse("8", "8"))
        assertNull(SleepCheckWindow.parse("-1", "8"))
        assertNull(SleepCheckWindow.parse("8", "25"))
        assertNull(SleepCheckWindow.parse("", "12"))
        assertNull(SleepCheckWindow.parse("8時", "12"))
    }

    @Test
    fun windowContainsStartButNotEnd() {
        assertTrue(8 in window)
        assertTrue(11 in window)
        assertFalse(12 in window)
        assertFalse(7 in window)
    }
}
