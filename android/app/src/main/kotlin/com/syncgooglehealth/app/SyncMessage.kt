package com.syncgooglehealth.app

// 送信結果の集計 (結果の文を作るため)
data class SyncTally(
    val sent: Int = 0,
    val notesWritten: Int = 0,
    val notesUnchanged: Int = 0,
    val notesFailed: Int = 0,
    val noteErrors: List<String> = emptyList(),
    val rejected: List<RejectedDay> = emptyList(),
) {
    fun add(days: Int, ok: IngestOk): SyncTally = copy(
        sent = sent + days,
        notesWritten = notesWritten + (ok.notes?.written ?: 0),
        notesUnchanged = notesUnchanged + (ok.notes?.unchanged ?: 0),
        notesFailed = notesFailed + (ok.notes?.failed ?: 0),
        noteErrors = noteErrors + listOfNotNull(ok.notes?.error),
        rejected = rejected + ok.rejected,
    )
}

private const val MAX_REJECTED_DATES = 5
private const val MAX_REJECTED_REASONS = 2
private const val MAX_REASON_LENGTH = 40

// 結果の文を作る。保存されなかった日は日付と理由だけを短く示す (健康データの値は載せない)
fun buildSyncMessage(texts: Texts, tally: SyncTally, includeNutrition: Boolean): String = buildString {
    append(texts.get(R.string.sync_message_sent, tally.sent))
    if (!includeNutrition) append(texts.get(R.string.sync_message_nutrition_skipped))
    val dates = tally.rejected.map { it.date }.distinct().sorted()
    if (dates.isNotEmpty()) {
        val detail = buildString {
            append(dates.take(MAX_REJECTED_DATES).joinToString(", "))
            if (dates.size > MAX_REJECTED_DATES) {
                append(texts.get(R.string.sync_message_rejected_more_dates, dates.size - MAX_REJECTED_DATES))
            }
            val reasons = tally.rejected.map { it.error.trim() }.filter { it.isNotEmpty() }.distinct()
            if (reasons.isNotEmpty()) {
                val separator = texts.get(R.string.common_list_separator)
                val shown = reasons.take(MAX_REJECTED_REASONS).joinToString(separator) { shorten(it) } +
                    if (reasons.size > MAX_REJECTED_REASONS) texts.get(R.string.sync_message_rejected_more_reasons) else ""
                append(texts.get(R.string.sync_message_rejected_reasons, shown))
            }
        }
        append(texts.get(R.string.sync_message_rejected, dates.size, detail))
    }
    append(texts.get(R.string.sync_message_notes, tally.notesWritten, tally.notesUnchanged, tally.notesFailed))
    if (tally.noteErrors.isNotEmpty()) {
        append(texts.get(R.string.sync_message_note_errors, tally.noteErrors.distinct().joinToString()))
    }
}

private fun shorten(s: String): String =
    if (s.length <= MAX_REASON_LENGTH) s else s.take(MAX_REASON_LENGTH) + "…"
