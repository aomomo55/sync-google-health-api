package com.syncgooglehealth.app

import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

// 送信の失敗が続いたことを、アプリを開かなくても通知で気づけるようにする (ADR 0026)。
// サーバーの自動停止からの起動の遅れなど、1 回だけの失敗では知らせない。
// データは保存できたがノートを書き込めなかった送信も、ここでは失敗として数える (ADR 0030)

// 失敗が続いている状態。sinceMillis は続いている失敗の 1 回目の時刻。成功したら null に戻す
data class FailureStreak(val sinceMillis: Long, val count: Int)

// 何回続けて失敗したら知らせるか
const val FAILURE_ALERT_MIN_ATTEMPTS = 2

// 睡眠を確かめる時間帯の外では、失敗がこの時間以上続いたら知らせる
const val FAILURE_ALERT_AFTER_HOURS = 3L

// 最後の成功からこの時間以上たっていたら、画面で自動送信が止まっている可能性を示す
const val STALE_SUCCESS_WARNING_HOURS = 12L

// 送信の履歴。「最後に試した」と「最後に成功した」を分けて持つ。記録が無い項目は null
data class SyncHistory(
    val lastAttemptMillis: Long?,
    val lastSuccessMillis: Long?,
    val lastResult: String?,
    val failureStreak: FailureStreak?,
    // 送信は成功したが注意が必要なこと (範囲外で保存されなかった日など)。結果の文とは別の行に出す
    val lastWarning: String? = null,
    // 最後に試した送信で、データは保存できたがノートを書き込めなかったか
    val lastNotesFailed: Boolean = false,
) {
    // 最後に試した送信が失敗したか (データを保存できなかったか)。ノートだけの失敗は lastNotesFailed で見分ける
    val lastFailed: Boolean get() = failureStreak != null && !lastNotesFailed
}

// 失敗の連続回数を消してよい「成功」か。データを保存できても、ノートを書き込めなかったら成功にしない (ADR 0030)
fun attemptSucceeded(status: SyncStatus, notesFailed: Boolean): Boolean = status == SyncStatus.OK && !notesFailed

// 送信の結果から、失敗が続いている状態を更新する
fun nextFailureStreak(current: FailureStreak?, succeeded: Boolean, nowMillis: Long): FailureStreak? = when {
    succeeded -> null
    current == null -> FailureStreak(nowMillis, 1)
    else -> current.copy(count = current.count + 1)
}

enum class SyncFailureAction { NOTIFY, CANCEL, NONE }

// 送信の後に、失敗の通知をどうするか決める。
// - 成功したら (手動を含む) 通知を消す
// - 通知は自動送信のときだけ、1 日 1 回まで。失敗が FAILURE_ALERT_MIN_ATTEMPTS 回以上続き、
//   FAILURE_ALERT_AFTER_HOURS 時間以上続いたときに出す
// - 睡眠を確かめる時間帯の中では、続いた時間を待たずに出す (送れていないと睡眠の未反映も判定できず、
//   「通知が来ない＝睡眠が届いている」が成り立たなくなるため)
fun syncFailureAction(
    nowMillis: Long,
    zone: ZoneId,
    streak: FailureStreak?,
    background: Boolean,
    lastNotified: LocalDate?,
    window: SleepCheckWindow,
): SyncFailureAction {
    if (streak == null) return SyncFailureAction.CANCEL
    val now = Instant.ofEpochMilli(nowMillis).atZone(zone)
    val lastedLongEnough = nowMillis - streak.sinceMillis >= Duration.ofHours(FAILURE_ALERT_AFTER_HOURS).toMillis()
    val due = streak.count >= FAILURE_ALERT_MIN_ATTEMPTS && (lastedLongEnough || now.hour in window)
    return if (background && due && lastNotified != now.toLocalDate()) SyncFailureAction.NOTIFY else SyncFailureAction.NONE
}

// 最後の成功から時間がたちすぎているか。成功の記録が無いとき (この記録を始める前の版から更新した直後など) は判断しない
fun isSuccessStale(nowMillis: Long, lastSuccessMillis: Long?): Boolean =
    lastSuccessMillis != null && nowMillis - lastSuccessMillis >= Duration.ofHours(STALE_SUCCESS_WARNING_HOURS).toMillis()

data class FailureNotice(val title: String, val text: String, val detail: String)

// 失敗の通知の文。健康データの値は載せない (ロック画面にも出るため)。
// lastSuccess は表示用に整えた時刻 (記録が無ければ null)、sleepUnchecked は睡眠を確かめる時間帯の中か。
// status が OK なのは、データは保存できたがノートを書き込めなかったとき (message にはノートの失敗の文を渡す)。
// このときは睡眠の未反映を判定できているので、睡眠の通知が出ないことは添えない
fun failureNotice(
    texts: Texts,
    status: SyncStatus,
    message: String,
    lastSuccess: String?,
    sleepUnchecked: Boolean,
): FailureNotice {
    val notesOnly = status == SyncStatus.OK
    val since = lastSuccess?.let { texts.get(R.string.notification_sync_failure_since_success, it) }
        ?: texts.get(R.string.notification_sync_failure_no_success)
    val detail = listOfNotNull(
        texts.get(R.string.notification_sync_failure_cause, message),
        failureHint(texts, status),
        texts.get(R.string.notification_sync_failure_not_in_notes, since),
        texts.get(R.string.notification_sync_failure_sleep_unchecked).takeIf { sleepUnchecked && !notesOnly },
    ).joinToString("\n")
    return FailureNotice(
        title = texts.get(if (notesOnly) R.string.notification_sync_failure_notes_title else R.string.notification_sync_failure_title),
        text = texts.get(R.string.notification_sync_failure_text, since),
        detail = detail,
    )
}

// 失敗の種類ごとに、次に何をすればよいか
fun failureHint(texts: Texts, status: SyncStatus): String = when (status) {
    SyncStatus.AUTH_ERROR -> texts.get(R.string.notification_sync_failure_hint_auth)
    SyncStatus.RETRYABLE -> texts.get(R.string.notification_sync_failure_hint_retryable)
    SyncStatus.FAILED -> texts.get(R.string.notification_sync_failure_hint_failed)
    SyncStatus.OK -> texts.get(R.string.notification_sync_failure_hint_notes)
}
