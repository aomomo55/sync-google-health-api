package com.syncgooglehealth.app

import java.time.LocalDate
import java.time.temporal.ChronoUnit

// 開始日として選べる、今日からさかのぼる最大の日数
const val MAX_START_DAYS_BACK = 90

// 履歴の権限が無いときに読める日数の目安 （権限を許可した日の 30 日前まで）
const val DEFAULT_READABLE_DAYS = 30

fun earliestSelectableStart(today: LocalDate): LocalDate = today.minusDays(MAX_START_DAYS_BACK.toLong())

fun isSelectableStart(date: LocalDate, today: LocalDate): Boolean =
    !date.isBefore(earliestSelectableStart(today)) && !date.isAfter(today)

// 履歴の権限が無いと読めない可能性がある開始日か
fun needsHistoryPermission(start: LocalDate, today: LocalDate): Boolean =
    start.isBefore(today.minusDays(DEFAULT_READABLE_DAYS.toLong()))

// [from, to] の日数 （両端を含む）
fun countDays(from: LocalDate, to: LocalDate): Int = (ChronoUnit.DAYS.between(from, to) + 1).toInt()

// 区切りごとの進捗表示。from は全体の開始日、[s, e] は送り終えた区切り
fun formatProgress(from: LocalDate, to: LocalDate, s: LocalDate, e: LocalDate): String =
    "$s〜$e を送信済み（${countDays(from, e)}/${countDays(from, to)} 日）"
