package com.syncgooglehealth.app

import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.format.DateTimeFormatter

// 起床後の時間帯 [startHour, endHour) の自動送信で、今日 (起床した日) の睡眠がまだ無ければ通知する。
// ウェアラブルから Health Connect への反映は、メーカーのアプリを開くまで遅れることがあるため。
// 睡眠の記録は起床後にできるので、時間帯は利用者が起床時刻に合わせて設定する。
// 遅く起きた日は起きる前にも確かめることになるが、時間帯の中の送信のたびに確かめ直す
data class SleepCheckWindow(val startHour: Int, val endHour: Int) {
    init {
        require(isValid(startHour, endHour)) { "時間帯が不正です: $startHour-$endHour" }
    }

    operator fun contains(hour: Int): Boolean = hour in startHour until endHour

    companion object {
        // 起床が 7 時台までの人を想定した既定値。合わなければ画面で変える
        const val DEFAULT_START_HOUR = 8
        const val DEFAULT_END_HOUR = 12
        private const val HOURS_PER_DAY = 24
        val DEFAULT = SleepCheckWindow(DEFAULT_START_HOUR, DEFAULT_END_HOUR)

        // 日をまたぐ時間帯は扱わない (起床後の判定に使うため不要)
        fun isValid(startHour: Int, endHour: Int): Boolean =
            startHour in 0 until HOURS_PER_DAY && endHour in 1..HOURS_PER_DAY && startHour < endHour

        // 画面の入力 (時の数字) から作る。不正なら null
        fun parse(start: String, end: String): SleepCheckWindow? {
            val s = start.trim().toIntOrNull() ?: return null
            val e = end.trim().toIntOrNull() ?: return null
            return if (isValid(s, e)) SleepCheckWindow(s, e) else null
        }
    }
}

enum class MissingSleepAction { NOTIFY, CANCEL, NONE }

// 送信した日次サマリーに、指定した日の睡眠があるか。睡眠は起床した日に属する
fun hasSleepOn(days: List<DailySummary>, date: LocalDate): Boolean =
    days.any { it.date == date.toString() && it.sleep != null }

// 送信が成功した後に、睡眠の未反映の通知をどうするか決める (ADR 0027)。
// - 睡眠が届いていれば通知を消す
// - 時間帯の中の自動送信のたびに確かめ直し、まだ無ければ通知を出す (出ていれば、確かめた時刻を新しくする)。
//   起きる前に確かめた日も、起きた後の送信で確かめ直した結果に置き換わる
// - 今日出した通知を利用者が消した (今日通知したのに今は出ていない) ら、その日はもう出さない
// - 前日以前の通知が残っていれば消す (日付が変わったら「昨夜」の意味が変わるため)
fun missingSleepAction(
    now: LocalDateTime,
    hasTodaySleep: Boolean,
    background: Boolean,
    lastNotified: LocalDate?,
    showing: Boolean,
    window: SleepCheckWindow,
): MissingSleepAction {
    val today = now.toLocalDate()
    val dismissedToday = lastNotified == today && !showing
    return when {
        hasTodaySleep -> MissingSleepAction.CANCEL
        background && now.hour in window && !dismissedToday -> MissingSleepAction.NOTIFY
        lastNotified != null && lastNotified < today -> MissingSleepAction.CANCEL
        else -> MissingSleepAction.NONE
    }
}

data class MissingSleepNotice(val title: String, val text: String, val detail: String)

// 通知の文。確かめた時刻を入れ、起きる前に確かめた結果か、起きた後に確かめ直した結果かを見分けられるようにする
fun missingSleepNotice(texts: Texts, checkedAt: LocalTime): MissingSleepNotice {
    val time = checkedAt.format(CHECKED_AT_FORMAT)
    return MissingSleepNotice(
        title = texts.get(R.string.notification_missing_sleep_title),
        text = texts.get(R.string.notification_missing_sleep_text, time),
        detail = texts.get(R.string.notification_missing_sleep_detail, time),
    )
}

private val CHECKED_AT_FORMAT: DateTimeFormatter = DateTimeFormatter.ofPattern("H:mm")
