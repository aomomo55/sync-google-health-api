package com.syncgooglehealth.app

import java.time.LocalDate
import java.time.temporal.ChronoUnit

// 定期送信と「今すぐ送信」で送る、今日を含む直近の日数
const val RECENT_SYNC_DAYS = 7

// 「過去N日を送る」で送る、今日を含む日数
const val BACKFILL_SYNC_DAYS = 30

// 開始日として選べる、今日からさかのぼる最大の日数
const val MAX_START_DAYS_BACK = 90

// 履歴の権限が無いときに読める日数の目安 （権限を許可した日の 30 日前まで）
const val DEFAULT_READABLE_DAYS = 30

// 履歴の権限が無くても確実に読める最も古い日。読める範囲の境目は「権限を許可した時刻の 30 日前」で
// 日の 0 時とずれるため、境目の日は含めない。許可した時刻は今より前なので、今日を含む 30 日なら必ず読める
fun earliestReadableWithoutHistory(today: LocalDate): LocalDate = today.minusDays(DEFAULT_READABLE_DAYS - 1L)

// 実際に読み始める日。履歴の権限が無いときは確実に読める日まで縮める。
// 境目より前を読むと、例外になるか、読める分だけに切り詰められた値（境目の日の歩数など）で
// サーバーの正しい値を上書きするおそれがあるため、最初から読まない
fun readableStart(from: LocalDate, today: LocalDate, canReadHistory: Boolean): LocalDate =
    if (canReadHistory) from else maxOf(from, earliestReadableWithoutHistory(today))

fun earliestSelectableStart(today: LocalDate): LocalDate = today.minusDays(MAX_START_DAYS_BACK.toLong())

fun isSelectableStart(date: LocalDate, today: LocalDate): Boolean =
    !date.isBefore(earliestSelectableStart(today)) && !date.isAfter(today)

// 履歴の権限が無いと読まない日を含む開始日か
fun needsHistoryPermission(start: LocalDate, today: LocalDate): Boolean =
    start.isBefore(earliestReadableWithoutHistory(today))

// [from, to] の日数 （両端を含む）
fun countDays(from: LocalDate, to: LocalDate): Int = (ChronoUnit.DAYS.between(from, to) + 1).toInt()

// 区切りごとの進捗表示。from は全体の開始日、[s, e] は送り終えた区切り
fun formatProgress(from: LocalDate, to: LocalDate, s: LocalDate, e: LocalDate): String =
    "$s〜$e を送信済み（${countDays(from, e)}/${countDays(from, to)} 日）"
