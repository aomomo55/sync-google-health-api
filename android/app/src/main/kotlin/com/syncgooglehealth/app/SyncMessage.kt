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

// 注意の文が複数あるときの区切り。画面ではこれで分けて、1 つずつ「注意:」の行にする
const val WARNING_LINE_SEPARATOR = "\n"

// 結果の文を作る。範囲外で保存されなかった日とノートの書き込みの失敗は、ここには含めず buildSyncWarning で別の行にする
fun buildSyncMessage(texts: Texts, tally: SyncTally, includeNutrition: Boolean): String = buildString {
    append(texts.get(R.string.sync_message_sent, tally.sent))
    if (!includeNutrition) append(texts.get(R.string.sync_message_nutrition_skipped))
    append(texts.get(R.string.sync_message_notes, tally.notesWritten, tally.notesUnchanged))
}

// 成功したが注意が必要なことをまとめる。保存されなかった日 (データが欠ける) を先に、ノートの書き込みの失敗を後に、
// 1 つずつ別の行にする。どちらも無ければ null
fun buildSyncWarning(texts: Texts, tally: SyncTally): String? =
    (listOfNotNull(buildRejectedWarning(texts, tally)) + buildNoteWarnings(texts, tally))
        .joinToString(WARNING_LINE_SEPARATOR)
        .ifEmpty { null }

// ノートの書き込みの失敗の文。件数で返る失敗と、同期そのものが失敗したときのエラーの文を、それぞれ 1 行にする
fun buildNoteWarnings(texts: Texts, tally: SyncTally): List<String> = listOfNotNull(
    tally.notesFailed.takeIf { it > 0 }?.let { texts.get(R.string.sync_warning_notes_failed, it) },
    tally.noteErrors.distinct().takeIf { it.isNotEmpty() }?.let {
        texts.get(R.string.sync_warning_note_errors, it.joinToString(texts.get(R.string.common_list_separator)))
    },
)

// 保存されなかった日の注意の文。日付と理由だけを短く示す (健康データの値は載せない)。
// 結果の文とは別の行に出すので、理由を短く切っても、この行そのものは切られない。保存されなかった日が無ければ null
fun buildRejectedWarning(texts: Texts, tally: SyncTally): String? {
    val dates = tally.rejected.map { it.date }.distinct().sorted()
    if (dates.isEmpty()) return null
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
    return texts.get(R.string.sync_message_rejected, dates.size, detail)
}

private fun shorten(s: String): String =
    if (s.length <= MAX_REASON_LENGTH) s else s.take(MAX_REASON_LENGTH) + "…"
