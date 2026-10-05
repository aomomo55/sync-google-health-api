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
fun buildSyncMessage(tally: SyncTally, includeNutrition: Boolean): String = buildString {
    append("${tally.sent}日分を送信しました")
    if (!includeNutrition) append("（栄養は権限が無いため送っていません）")
    val dates = tally.rejected.map { it.date }.distinct().sorted()
    if (dates.isNotEmpty()) {
        append("（${dates.size}日分は値が範囲外のため保存されませんでした: ")
        append(dates.take(MAX_REJECTED_DATES).joinToString(", "))
        if (dates.size > MAX_REJECTED_DATES) append(" ほか${dates.size - MAX_REJECTED_DATES}日")
        val reasons = tally.rejected.map { it.error.trim() }.filter { it.isNotEmpty() }.distinct()
        if (reasons.isNotEmpty()) {
            append(" / 理由: ")
            append(reasons.take(MAX_REJECTED_REASONS).joinToString("、") { shorten(it) })
            if (reasons.size > MAX_REJECTED_REASONS) append(" ほか")
        }
        append("）")
    }
    append(" / ノート 更新${tally.notesWritten}・変更なし${tally.notesUnchanged}・失敗${tally.notesFailed}")
    if (tally.noteErrors.isNotEmpty()) append(" / ノートエラー: ${tally.noteErrors.distinct().joinToString()}")
}

private fun shorten(s: String): String =
    if (s.length <= MAX_REASON_LENGTH) s else s.take(MAX_REASON_LENGTH) + "…"
