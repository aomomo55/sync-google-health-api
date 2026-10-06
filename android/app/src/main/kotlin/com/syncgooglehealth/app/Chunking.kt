package com.syncgooglehealth.app

import java.time.LocalDate

const val MAX_DAYS_PER_REQUEST = 30

// [from, to] を最大 max 日ずつの範囲に分割する
fun chunkRanges(from: LocalDate, to: LocalDate, max: Int = MAX_DAYS_PER_REQUEST): List<Pair<LocalDate, LocalDate>> {
    require(max > 0)
    return generateSequence(from) { it.plusDays(max.toLong()) }
        .takeWhile { !it.isAfter(to) }
        .map { s -> s to minOf(s.plusDays(max - 1L), to) }
        .toList()
}

fun chunkDays(days: List<DailySummary>, max: Int = MAX_DAYS_PER_REQUEST): List<List<DailySummary>> =
    days.chunked(max)
