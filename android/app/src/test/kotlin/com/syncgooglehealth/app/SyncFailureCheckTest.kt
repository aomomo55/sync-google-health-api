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

    @Test
    fun historyTellsNoteFailureApartFromSendFailure() {
        val history = SyncHistory(at(10), at(9), "ok", FailureStreak(at(10), 1), lastNotesFailed = true)
        assertFalse(history.lastFailed)
        assertTrue(history.lastNotesFailed)
    }

    @Test
    fun noteFailureIsNotASuccess() {
        assertTrue(attemptSucceeded(SyncStatus.OK, notesFailed = false))
        assertFalse(attemptSucceeded(SyncStatus.OK, notesFailed = true))
        assertFalse(attemptSucceeded(SyncStatus.RETRYABLE, notesFailed = false))
        assertFalse(attemptSucceeded(SyncStatus.AUTH_ERROR, notesFailed = false))
    }

    @Test
    fun noteFailuresCountTowardTheSameStreakAndNotify() {
        // ノートの失敗と送信の失敗は同じ連続回数に数え、同じ条件で通知する
        val first = nextFailureStreak(null, attemptSucceeded(SyncStatus.OK, notesFailed = true), at(10))
        val second = nextFailureStreak(first, attemptSucceeded(SyncStatus.RETRYABLE, notesFailed = false), at(11))
        val third = nextFailureStreak(second, attemptSucceeded(SyncStatus.OK, notesFailed = true), at(13))
        assertEquals(FailureStreak(at(10), 3), third)
        assertEquals(SyncFailureAction.NOTIFY, action(at(13), third))
        assertEquals(SyncFailureAction.NONE, action(at(10), first))
        assertNull(nextFailureStreak(third, attemptSucceeded(SyncStatus.OK, notesFailed = false), at(14)))
    }

    // ノートの失敗の通知を、実際の注意の文 (サーバーの文を含む) から作る
    private fun noteNotice(tally: SyncTally): FailureNotice {
        val cause = buildNoteWarnings(TestTexts, tally).joinToString(WARNING_LINE_SEPARATOR)
        return failureNotice(TestTexts, SyncStatus.OK, cause, "2026/01/10 06:00", sleepUnchecked = true)
    }

    private fun occurrences(text: String, word: String): Int = text.windowed(word.length).count { it == word }

    @Test
    fun noteFailureNoticeSaysDataIsSavedAndPointsToTheCause() {
        val tally = SyncTally().add(
            3,
            IngestOk(3, NotesResult(0, 0, listOf(FailedNote("Health/Daily/2026-01-05.md", ServerMessages.NOTE_FAILURE)), null)),
        )
        val notice = noteNotice(tally)
        assertEquals("ノートを書き込めていません", notice.title)
        assertTrue(notice.text.contains("2026/01/10 06:00"))
        assertTrue(notice.detail, notice.detail.contains("原因: ノート1件（2026-01-05.md）を書き込めませんでした"))
        assertTrue(notice.detail, notice.detail.contains("ノートだけを書き込めていません"))
        // 次にすることはサーバーの文の 1 回だけで、アプリの文でくり返さない
        assertEquals(notice.detail, 1, occurrences(notice.detail, "obsidian-sync-mcp"))
        assertEquals(notice.detail, 1, occurrences(notice.detail, "作り直"))
        // ノートだけの失敗では睡眠の未反映を判定できているので、睡眠の通知が出ないとは書かない
        assertFalse(notice.detail.contains("睡眠"))
    }

    @Test
    fun noteSyncErrorNoticeDoesNotRepeatTheNextStep() {
        val tally = SyncTally().add(3, IngestOk(3, NotesResult(0, 0, emptyList(), ServerMessages.SYNC_FAILURE)))
        val notice = noteNotice(tally)
        assertTrue(notice.detail, notice.detail.contains("原因: ノートの書き込みでエラー: ノートの同期に失敗しました"))
        assertEquals(notice.detail, 1, occurrences(notice.detail, "obsidian-sync-mcp"))
        assertEquals(notice.detail, 1, occurrences(notice.detail, "作り直"))
    }

    @Test
    fun missingMemoMarkerNoticeDoesNotSuggestCheckingTheServer() {
        // メモ欄のマーカーが無いのは送り直しでは直らない。サーバーの文にある直し方だけを出す
        val tally = SyncTally().add(
            1,
            IngestOk(1, NotesResult(0, 0, listOf(FailedNote("Health/Daily/2026-01-05.md", ServerMessages.MEMO_MARKER_MISSING)), null)),
        )
        val notice = noteNotice(tally)
        assertTrue(notice.detail, notice.detail.contains("マーカーの行を戻す"))
        assertFalse(notice.detail, notice.detail.contains("obsidian-sync-mcp"))
        assertFalse(notice.detail, notice.detail.contains("送り直"))
    }
}
