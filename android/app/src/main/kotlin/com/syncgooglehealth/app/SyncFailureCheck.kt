package com.syncgooglehealth.app

import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

// 送信の失敗が続いたことを、アプリを開かなくても通知で気づけるようにする (ADR 0026)。
// サーバーの自動停止からの起動の遅れなど、1 回だけの失敗では知らせない

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
) {
    // 最後に試した送信が失敗したか
    val lastFailed: Boolean get() = failureStreak != null
}

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
// lastSuccess は表示用に整えた時刻 (記録が無ければ null)、sleepUnchecked は睡眠を確かめる時間帯の中か
fun failureNotice(status: SyncStatus, message: String, lastSuccess: String?, sleepUnchecked: Boolean): FailureNotice {
    val since = lastSuccess?.let { "最後に成功したのは $it です" } ?: "成功した記録がありません"
    val detail = listOfNotNull(
        "原因: $message",
        failureHint(status),
        "$since。それより後のデータはノートに入っていません",
        "送れていない間は、睡眠の未反映の通知も出ません".takeIf { sleepUnchecked },
    ).joinToString("\n")
    return FailureNotice(
        title = "健康データを送れていません",
        text = "$since。アプリを開いて確かめてください",
        detail = detail,
    )
}

// 失敗の種類ごとに、次に何をすればよいか
fun failureHint(status: SyncStatus): String = when (status) {
    SyncStatus.AUTH_ERROR -> "アプリの設定で API トークンを確かめてください"
    SyncStatus.RETRYABLE -> "サーバーかネットワークの一時的な問題とみて、自動で再試行しています。続くときはサーバーが動いているか確かめてください"
    SyncStatus.FAILED, SyncStatus.OK -> "アプリを開き、画面の「結果」に沿って直してください"
}
