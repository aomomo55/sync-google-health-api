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

    // 起床日 (終了時刻のローカル日付) ごとに 1 つの SleepSummary を作る
    fun assign(sessions: List<SleepSessionInput>, zone: ZoneId): Map<LocalDate, SleepSummary> {
        val byDate = sessions
            .filter { it.end > it.start }
            .groupBy { it.end.atZone(zone).toLocalDate() }
        return byDate.mapValues { (_, list) -> summarize(pickOrigin(list), zone) }
    }

    // ステージ付きの起源を優先し、次に合計時間が長いもの。同点は起源 id の辞書順
    private fun pickOrigin(list: List<SleepSessionInput>): List<SleepSessionInput> {
        val chosen = list.groupBy { it.origin }.entries.minWithOrNull(
            compareByDescending<Map.Entry<String, List<SleepSessionInput>>> { (_, v) -> v.any(::hasStagedSleep) }
                .thenByDescending { (_, v) -> v.sumOf { Duration.between(it.start, it.end).seconds } }
                .thenBy { it.key },
        )!!.key
        return list.filter { it.origin == chosen }
    }

    private fun hasStagedSleep(s: SleepSessionInput): Boolean =
        s.stages.any { it.type == DEEP || it.type == LIGHT || it.type == REM }

    private fun summarize(sessions: List<SleepSessionInput>, zone: ZoneId): SleepSummary {
        val main = sessions.maxBy { Duration.between(it.start, it.end).seconds }
        val naps = sessions.filter { it !== main }
        val napMinutes = if (naps.isEmpty()) null else naps.sumOf { asleepMinutes(it) }

        val inBed = minutes(Duration.between(main.start, main.end).seconds)
        val hasStages = main.stages.isNotEmpty()
        val awake = stageMinutes(main) { it.type in AWAKE_TYPES }
        val asleep = if (hasStages) (inBed - awake).coerceAtLeast(0) else inBed
        return SleepSummary(
            start = fmt(main.start, zone),
            end = fmt(main.end, zone),
            asleepMinutes = asleep,
            inBedMinutes = inBed,
            awakeMinutes = if (hasStages) awake else null,
            deepMinutes = if (hasStages) stageMinutes(main) { it.type == DEEP } else null,
            lightMinutes = if (hasStages) stageMinutes(main) { it.type == LIGHT } else null,
            remMinutes = if (hasStages) stageMinutes(main) { it.type == REM } else null,
            napMinutes = napMinutes,
        )
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
