package com.syncgooglehealth.app

import java.time.LocalDate

const val MAX_DAYS_PER_REQUEST = 30

// [from, to] を最大 max 日ずつの範囲に分割する
fun chunkRanges(from: LocalDate, to: LocalDate, max: Int = MAX_DAYS_PER_REQUEST): List<Pair<LocalDate, LocalDate>> {
    require(max > 0)
    val out = mutableListOf<Pair<LocalDate, LocalDate>>()
    var s = from
    while (!s.isAfter(to)) {
        val e = minOf(s.plusDays(max - 1L), to)
        out += s to e
        s = e.plusDays(1)
    }
    return out
}

fun chunkDays(days: List<DailySummary>, max: Int = MAX_DAYS_PER_REQUEST): List<List<DailySummary>> =
    days.chunked(max)
