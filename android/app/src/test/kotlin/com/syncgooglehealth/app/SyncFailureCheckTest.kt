package com.syncgooglehealth.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate
import java.time.ZoneId

class SyncFailureCheckTest {
    private val zone = ZoneId.of("Asia/Tokyo")
    private val today = LocalDate.of(2026, 1, 10)
    private val window = SleepCheckWindow(8, 12)
    private val hour = 3_600_000L
    private fun at(hour: Int, minute: Int = 0): Long = today.atTime(hour, minute).atZone(zone).toInstant().toEpochMilli()

    private fun action(
        now: Long,
        streak: FailureStreak?,
        background: Boolean = true,
        lastNotified: LocalDate? = null,
    ) = syncFailureAction(now, zone, streak, background, lastNotified, window)

    @Test
    fun streakStartsAtTheFirstFailureAndResetsOnSuccess() {
        val first = nextFailureStreak(null, succeeded = false, nowMillis = at(1))
        assertEquals(FailureStreak(at(1), 1), first)
        val second = nextFailureStreak(first, succeeded = false, nowMillis = at(2))
        assertEquals(FailureStreak(at(1), 2), second)
        assertNull(nextFailureStreak(second, succeeded = true, nowMillis = at(3)))
    }

    @Test
    fun cancelsOnSuccessEvenOnManualSync() {
        assertEquals(SyncFailureAction.CANCEL, action(at(14), streak = null))
        assertEquals(SyncFailureAction.CANCEL, action(at(14), streak = null, background = false))
    }

    @Test
    fun doesNotNotifyOnASingleFailure() {
        // 1 回だけなら、長く空いていても知らせない (サーバーの起動待ちなど)
        assertEquals(SyncFailureAction.NONE, action(at(14), FailureStreak(at(14) - 5 * hour, 1)))
    }

    @Test
    fun notifiesWhenFailuresLastLongEnoughOutsideTheWindow() {
        assertEquals(SyncFailureAction.NONE, action(at(14), FailureStreak(at(14) - 2 * hour, 3)))
        assertEquals(SyncFailureAction.NOTIFY, action(at(14), FailureStreak(at(14) - 3 * hour, 2)))
        // 夜中も通知は出す (音を鳴らさないチャンネルなので起こさない)
        assertEquals(SyncFailureAction.NOTIFY, action(at(3), FailureStreak(at(3) - 4 * hour, 4)))
    }

    @Test
    fun notifiesWithoutWaitingInsideTheSleepCheckWindow() {
        assertEquals(SyncFailureAction.NOTIFY, action(at(9), FailureStreak(at(9) - 15 * 60_000L, 2)))
        assertEquals(SyncFailureAction.NONE, action(at(9), FailureStreak(at(9), 1)))
        assertEquals(SyncFailureAction.NONE, action(at(12), FailureStreak(at(12) - hour, 2)))
    }

    @Test
    fun notifiesAtMostOncePerDayAndNotOnManualSync() {
        val streak = FailureStreak(at(14) - 5 * hour, 5)
        assertEquals(SyncFailureAction.NONE, action(at(14), streak, lastNotified = today))
        assertEquals(SyncFailureAction.NOTIFY, action(at(14), streak, lastNotified = today.minusDays(1)))
        assertEquals(SyncFailureAction.NONE, action(at(14), streak, background = false))
    }

    @Test
    fun successIsStaleOnlyAfterTheThreshold() {
        val now = at(20)
        assertFalse(isSuccessStale(now, null))
        assertFalse(isSuccessStale(now, now - (STALE_SUCCESS_WARNING_HOURS * hour - 1)))
        assertTrue(isSuccessStale(now, now - STALE_SUCCESS_WARNING_HOURS * hour))
    }

    @Test
    fun noticeTellsWhenItLastSucceededAndWhatToDo() {
        val notice = failureNotice(TestTexts, SyncStatus.AUTH_ERROR, "トークンが正しくありません", "2026/01/10 06:00", sleepUnchecked = false)
        assertEquals("健康データを送れていません", notice.title)
        assertTrue(notice.text.contains("2026/01/10 06:00"))
        assertTrue(notice.detail.contains("原因: トークンが正しくありません"))
        assertTrue(notice.detail.contains("API トークン"))
        assertFalse(notice.detail.contains("睡眠"))
    }

    @Test
    fun noticeMentionsTheSleepCheckInsideTheWindowAndMissingSuccess() {
        val notice = failureNotice(TestTexts, SyncStatus.RETRYABLE, "サーバーエラー (503)", null, sleepUnchecked = true)
        assertTrue(notice.text.contains("成功した記録がありません"))
        assertTrue(notice.detail.contains("再試行"))
        assertTrue(notice.detail.contains("睡眠の未反映の通知も出ません"))
    }

    @Test
    fun historyTellsWhetherTheLastAttemptFailed() {
        assertFalse(SyncHistory(at(9), at(9), "ok", null).lastFailed)
        assertTrue(SyncHistory(at(10), at(9), "ng", FailureStreak(at(10), 1)).lastFailed)
    }
}
