package com.syncgooglehealth.app

import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter

data class SleepStage(val type: Int, val start: Instant, val end: Instant)

data class SleepSessionInput(
    val origin: String,
    val start: Instant,
    val end: Instant,
    val stages: List<SleepStage>,
)

object SleepAssigner {
    // SleepSessionRecord.STAGE_TYPE_* の値
    private val AWAKE_TYPES = setOf(1, 3, 7)
    private const val DEEP = 5
    private const val LIGHT = 4
    private const val REM = 6

    private val FORMAT = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ssxxx")

    // 間隔がこれ以内の同じ起源のセッションは、一晩の睡眠として結合する
    val MERGE_GAP: Duration = Duration.ofHours(2)

    // 結合したセッションのまとまり。start / end は最初の開始と最後の終了
    private class Night(val origin: String, val sessions: List<SleepSessionInput>) {
        val start: Instant = sessions.first().start
        val end: Instant = sessions.maxOf { it.end }
        val span: Long get() = Duration.between(start, end).seconds
    }

    // 起床日 (結合後の終了時刻のローカル日付) ごとに 1 つの SleepSummary を作る
    fun assign(
        sessions: List<SleepSessionInput>,
        zone: ZoneId,
        mergeGap: Duration = MERGE_GAP,
    ): Map<LocalDate, SleepSummary> {
        val byDate = sessions
            .filter { it.end > it.start }
            .groupBy { it.origin }
            .values
            .flatMap { mergeNights(it, mergeGap) }
            .groupBy { it.end.atZone(zone).toLocalDate() }
        return byDate.mapValues { (_, list) -> summarize(pickOrigin(list), zone) }
    }

    // 開始順に並べ、前のまとまりの終了から mergeGap 以内に始まるセッションを同じまとまりにする
    private fun mergeNights(list: List<SleepSessionInput>, mergeGap: Duration): List<Night> {
        val groups = mutableListOf<MutableList<SleepSessionInput>>()
        // 直前までのまとまりの終了時刻を更新しながら走査するため var
        var end: Instant? = null
        for (s in list.sortedWith(compareBy({ it.start }, { it.end }))) {
            if (end != null && Duration.between(end, s.start) <= mergeGap) {
                groups.last().add(s)
                if (s.end > end) end = s.end
            } else {
                groups.add(mutableListOf(s))
                end = s.end
            }
        }
        return groups.map { Night(it.first().origin, it) }
    }

    // ステージ付きの起源を優先し、次に合計時間が長いもの。同点は起源 id の辞書順
    private fun pickOrigin(list: List<Night>): List<Night> {
        val chosen = list.groupBy { it.origin }.entries.minWithOrNull(
            compareByDescending<Map.Entry<String, List<Night>>> { (_, v) -> v.any { n -> n.sessions.any(::hasStagedSleep) } }
                .thenByDescending { (_, v) -> v.sumOf { n -> n.sessions.sumOf { Duration.between(it.start, it.end).seconds } } }
                .thenBy { it.key },
        )!!.key
        return list.filter { it.origin == chosen }
    }

    private fun hasStagedSleep(s: SleepSessionInput): Boolean =
        s.stages.any { it.type == DEEP || it.type == LIGHT || it.type == REM }

    // 最長のまとまりを本睡眠、残りを仮眠とする。まとまり内のセッション間の間隔は中途覚醒に数える
    private fun summarize(nights: List<Night>, zone: ZoneId): SleepSummary {
        val main = nights.maxBy { it.span }
        val naps = nights.filter { it !== main }.flatMap { it.sessions }
        val napMinutes = if (naps.isEmpty()) null else naps.sumOf { asleepMinutes(it) }

        val inBed = minutes(main.span)
        val hasStages = main.sessions.any { it.stages.isNotEmpty() }
        val gap = minutes(gapSeconds(main.sessions))
        val awake = main.sessions.sumOf { stageMinutes(it) { st -> st.type in AWAKE_TYPES } } + gap
        val asleep = (inBed - awake).coerceAtLeast(0)
        fun stages(type: Int) = main.sessions.sumOf { stageMinutes(it) { st -> st.type == type } }
        return SleepSummary(
            start = fmt(main.start, zone),
            end = fmt(main.end, zone),
            asleepMinutes = asleep,
            inBedMinutes = inBed,
            awakeMinutes = if (hasStages) awake else null,
            deepMinutes = if (hasStages) stages(DEEP) else null,
            lightMinutes = if (hasStages) stages(LIGHT) else null,
            remMinutes = if (hasStages) stages(REM) else null,
            napMinutes = napMinutes,
        )
    }

    // 開始順のセッション間で、どのセッションにも覆われていない時間の合計
    private fun gapSeconds(sessions: List<SleepSessionInput>): Long {
        // 覆われた終了時刻を更新しながら走査するため var
        var total = 0L
        var end = sessions.first().end
        for (s in sessions.drop(1)) {
            if (s.start > end) total += Duration.between(end, s.start).seconds
            if (s.end > end) end = s.end
        }
        return total
    }

    private fun asleepMinutes(s: SleepSessionInput): Long {
        val inBed = minutes(Duration.between(s.start, s.end).seconds)
        if (s.stages.isEmpty()) return inBed
        return (inBed - stageMinutes(s) { it.type in AWAKE_TYPES }).coerceAtLeast(0)
    }

    private fun stageMinutes(s: SleepSessionInput, pred: (SleepStage) -> Boolean): Long =
        minutes(s.stages.filter(pred).sumOf { Duration.between(it.start, it.end).seconds })

    private fun minutes(seconds: Long): Long = Math.round(seconds / 60.0)

    private fun fmt(i: Instant, zone: ZoneId): String =
        FORMAT.format(i.atZone(zone).withNano(0))
}
