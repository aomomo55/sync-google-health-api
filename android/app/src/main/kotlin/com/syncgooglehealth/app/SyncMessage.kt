package com.syncgooglehealth.app

// 送信結果の集計 (結果の文を作るため)
data class SyncTally(
    val sent: Int = 0,
    val notesWritten: Int = 0,
    val notesUnchanged: Int = 0,
    val failedNotes: List<FailedNote> = emptyList(),
    val noteErrors: List<String> = emptyList(),
    val rejected: List<RejectedDay> = emptyList(),
) {
    fun add(days: Int, ok: IngestOk): SyncTally = copy(
        sent = sent + days,
        notesWritten = notesWritten + (ok.notes?.written ?: 0),
        notesUnchanged = notesUnchanged + (ok.notes?.unchanged ?: 0),
        failedNotes = failedNotes + (ok.notes?.failed ?: emptyList()),
        noteErrors = noteErrors + listOfNotNull(ok.notes?.error),
        rejected = rejected + ok.rejected,
    )
}

private const val MAX_REJECTED_DATES = 5
private const val MAX_REJECTED_REASONS = 2
private const val MAX_REASON_LENGTH = 40
// ノートの失敗で、理由ごとの行を何行まで出すか (それより多い理由は件数だけを 1 行にまとめる)
private const val MAX_NOTE_FAILURE_REASONS = 3
// 1 行に並べるノートのファイル名の数
private const val MAX_FAILED_NOTE_NAMES = 3

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

// ノートの書き込みの失敗の文。書き込めなかったノートは理由ごとに 1 行、同期そのものが失敗したときのエラーも 1 行にする。
// 次にすること (obsidian-sync-mcp を確かめる、ノートのメモ欄のマーカーを戻す、など) は理由によって違い、
// サーバーの文に書いてあるので、アプリでは案内を足さずにサーバーの文をそのまま出す。
// アプリがサーバーの文言を見て案内を選ぶと、サーバーの文を変えたときに食い違うため
fun buildNoteWarnings(texts: Texts, tally: SyncTally): List<String> {
    val byReason = tally.failedNotes.groupBy { it.error.trim() }.toList()
    val shown = byReason.take(MAX_NOTE_FAILURE_REASONS).map { (reason, notes) -> failedNotesLine(texts, reason, notes) }
    val others = byReason.drop(MAX_NOTE_FAILURE_REASONS).sumOf { it.second.size }
    return shown +
        listOfNotNull(
            others.takeIf { it > 0 }?.let { texts.get(R.string.sync_warning_notes_other_reasons, it) },
            tally.noteErrors.distinct().takeIf { it.isNotEmpty() }?.let {
                texts.get(R.string.sync_warning_note_errors, it.joinToString(texts.get(R.string.common_list_separator)))
            },
        )
}

// 同じ理由で書き込めなかったノートの 1 行。ノートはファイル名だけを示す (どのノートかが分かれば足り、行を短くするため)
private fun failedNotesLine(texts: Texts, reason: String, notes: List<FailedNote>): String {
    val names = notes.map { it.path.substringAfterLast('/').trim() }.filter { it.isNotEmpty() }.distinct()
    val shownReason = reason.ifEmpty { texts.get(R.string.sync_warning_note_reason_unknown) }
    if (names.isEmpty()) return texts.get(R.string.sync_warning_notes_failed_no_name, notes.size, shownReason)
    val shownNames = names.take(MAX_FAILED_NOTE_NAMES).joinToString(texts.get(R.string.common_list_separator)) +
        if (names.size > MAX_FAILED_NOTE_NAMES) texts.get(R.string.sync_warning_notes_more_names, names.size - MAX_FAILED_NOTE_NAMES) else ""
    return texts.get(R.string.sync_warning_notes_failed, notes.size, shownNames, shownReason)
}

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
