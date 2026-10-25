package com.syncgooglehealth.app

import org.junit.Assert.assertEquals
import org.junit.Test
import java.time.Instant
import java.time.LocalDate
import java.util.TimeZone

class CalendarDayTest {
    // 端末のタイムゾーンを日本以外にして実行し、結果が変わらないことを確かめる
    private fun <T> withDefaultTimeZone(id: String, block: () -> T): T {
        val original = TimeZone.getDefault()
        TimeZone.setDefault(TimeZone.getTimeZone(id))
        return try {
            block()
        } finally {
            TimeZone.setDefault(original)
        }
    }

    @Test
    fun calendarDateIsTokyoDateEvenWhenDeviceIsInAnotherZone() {
        // UTC では 1 月 10 日 15:30、日本時間では 1 月 11 日 0:30
        val instant = Instant.parse("2026-01-10T15:30:00Z")
        listOf("UTC", "America/Los_Angeles", "Europe/Berlin").forEach { id ->
            assertEquals(LocalDate.of(2026, 1, 11), withDefaultTimeZone(id) { calendarDateOf(instant) })
        }
    }

    @Test
    fun calendarDayStartsAtTokyoMidnight() {
        val start = withDefaultTimeZone("America/New_York") { startOfCalendarDay(LocalDate.of(2026, 1, 11)) }
        assertEquals(Instant.parse("2026-01-10T15:00:00Z"), start)
    }

    @Test
    fun lastInstantOfTokyoDayBelongsToThatDay() {
        val nextStart = startOfCalendarDay(LocalDate.of(2026, 1, 12))
        assertEquals(LocalDate.of(2026, 1, 11), calendarDateOf(nextStart.minusMillis(1)))
        assertEquals(LocalDate.of(2026, 1, 12), calendarDateOf(nextStart))
    }

    @Test
    fun fixedDayLengthSlicesAlignWithTokyoDaysAcrossAYear() {
        // 集計を 24 時間ずつ区切るので、どの日の区切りも日本時間の 0 時と一致すること (夏時間が無い前提の確認)
        val from = LocalDate.of(2026, 1, 1)
        val days = from.datesUntil(from.plusYears(1)).toList()
        days.forEachIndexed { i, date ->
            val sliceStart = startOfCalendarDay(from).plus(CALENDAR_DAY_LENGTH.multipliedBy(i.toLong()))
            assertEquals(startOfCalendarDay(date), sliceStart)
            assertEquals(date, calendarDateOf(sliceStart))
        }
    }

    @Test
    fun formatsTimeInTokyoEvenWhenDeviceIsInAnotherZone() {
        val instant = Instant.parse("2026-01-10T15:30:00Z")
        assertEquals("2026/01/11 00:30", withDefaultTimeZone("Europe/London") { formatCalendarTime(instant) })
    }
}
