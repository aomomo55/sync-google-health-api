package com.syncgooglehealth.app

import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

// 日付は Asia/Tokyo の暦日（サーバーの domain/dates.ts と同じ規則）。
// 端末のタイムゾーンには従わず、海外にいても日本の暦日で記録し、睡眠の通知の時間帯も日本時間で判定する
val CALENDAR_ZONE: ZoneId = ZoneId.of("Asia/Tokyo")

// 日本は夏時間が無いので、暦日は常に 24 時間。Health Connect の集計をこの長さで区切ると暦日にそろう
val CALENDAR_DAY_LENGTH: Duration = Duration.ofDays(1)

fun calendarDateOf(instant: Instant): LocalDate = instant.atZone(CALENDAR_ZONE).toLocalDate()

fun startOfCalendarDay(date: LocalDate): Instant = date.atStartOfDay(CALENDAR_ZONE).toInstant()

// 画面と通知に出す時刻。日付を暦日と食い違わせないよう、また睡眠の通知の「確認した時刻」や
// 時間帯の設定と同じ時計で読めるよう、端末のタイムゾーンではなく日本時間で出す
private val CALENDAR_TIME_FORMAT: DateTimeFormatter =
    DateTimeFormatter.ofPattern("yyyy/MM/dd HH:mm", Locale.JAPAN).withZone(CALENDAR_ZONE)

fun formatCalendarTime(instant: Instant): String = CALENDAR_TIME_FORMAT.format(instant)
