package com.syncgooglehealth.app

import java.time.LocalDate
import java.time.LocalDateTime

// 起床後の時間帯 [START, END) の自動送信で、今日 (起床した日) の睡眠がまだ無ければ通知する。
// ウェアラブルから Health Connect への反映は、メーカーのアプリを開くまで遅れることがあるため
const val MISSING_SLEEP_CHECK_START_HOUR = 6
const val MISSING_SLEEP_CHECK_END_HOUR = 11

enum class MissingSleepAction { NOTIFY, CANCEL, NONE }

// 送信した日次サマリーに、指定した日の睡眠があるか。睡眠は起床した日に属する
fun hasSleepOn(days: List<DailySummary>, date: LocalDate): Boolean =
    days.any { it.date == date.toString() && it.sleep != null }

// 送信が成功した後に、睡眠の未反映の通知をどうするか決める。
// 睡眠が届いていれば通知を消す。通知は自動送信のときだけ、時間帯の中で 1 日 1 回まで
fun missingSleepAction(
    now: LocalDateTime,
    hasTodaySleep: Boolean,
    background: Boolean,
    lastNotified: LocalDate?,
): MissingSleepAction = when {
    hasTodaySleep -> MissingSleepAction.CANCEL
    !background -> MissingSleepAction.NONE
    now.hour !in MISSING_SLEEP_CHECK_START_HOUR until MISSING_SLEEP_CHECK_END_HOUR -> MissingSleepAction.NONE
    lastNotified == now.toLocalDate() -> MissingSleepAction.NONE
    else -> MissingSleepAction.NOTIFY
}
