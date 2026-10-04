package com.syncgooglehealth.app

import java.math.BigDecimal
import java.math.RoundingMode
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

// Health Connect の型に依存しない入力データ。HealthReader が詰め替える。
data class ExerciseSpan(val start: Instant, val end: Instant, val isWalking: Boolean)

data class RawDay(
    val steps: Long? = null,
    val distanceM: Double? = null,
    val caloriesKcal: Double? = null,
    val hrAvg: Double? = null,
    val hrMax: Long? = null,
    val hrMin: Long? = null,
    val restingBpm: Long? = null,
    val weightKg: Double? = null,
    val bodyFatPct: Double? = null,
    val energyKcal: Double? = null,
    val proteinG: Double? = null,
    val fatG: Double? = null,
    val carbsG: Double? = null,
    val exercise: List<ExerciseSpan> = emptyList(),
)

fun round(v: Double, decimals: Int): Double =
    BigDecimal(v).setScale(decimals, RoundingMode.HALF_UP).toDouble()

object DayAggregator {
    fun build(date: LocalDate, zone: ZoneId, raw: RawDay, sleep: SleepSummary?): DailySummary {
        val dayStart = date.atStartOfDay(zone).toInstant()
        val dayEnd = date.plusDays(1).atStartOfDay(zone).toInstant()
        val move = clippedMinutes(raw.exercise, dayStart, dayEnd, walkingOnly = false)
        val walking = clippedMinutes(raw.exercise, dayStart, dayEnd, walkingOnly = true)

        val activity = ActivitySummary(
            steps = raw.steps,
            distanceM = raw.distanceM?.let { round(it, 1) },
            caloriesKcal = raw.caloriesKcal?.let { round(it, 1) },
            moveMinutes = move,
            walkingMinutes = walking,
        )
        val hr = HeartRateSummary(
            avgBpm = raw.hrAvg?.let { round(it, 1) },
            maxBpm = raw.hrMax,
            minBpm = raw.hrMin,
            restingBpm = raw.restingBpm,
        )
        val body = BodySummary(
            weightKg = raw.weightKg?.let { round(it, 2) },
            bodyFatPct = raw.bodyFatPct?.let { round(it, 1) },
        )
        val nutrition = NutritionSummary(
            energyKcal = raw.energyKcal?.let { Math.round(it) },
            proteinG = raw.proteinG?.let { round(it, 1) },
            fatG = raw.fatG?.let { round(it, 1) },
            carbsG = raw.carbsG?.let { round(it, 1) },
        )
        return DailySummary(
            date = date.toString(),
            activity = activity.takeUnless { it.isEmpty() },
            heartRate = hr.takeUnless { it.isEmpty() },
            body = body.takeUnless { it.isEmpty() },
            sleep = sleep,
            nutrition = nutrition.takeUnless { it.isEmpty() },
        )
    }

    // 日の範囲にクリップし、重なりは統合して合計分数を返す。該当なしなら null
    fun clippedMinutes(spans: List<ExerciseSpan>, dayStart: Instant, dayEnd: Instant, walkingOnly: Boolean): Long? {
        val clipped = spans
            .filter { !walkingOnly || it.isWalking }
            .map { maxOf(it.start, dayStart) to minOf(it.end, dayEnd) }
            .filter { it.first < it.second }
            .sortedBy { it.first }
        if (clipped.isEmpty()) return null
        var totalMs = 0L
        var curStart = clipped[0].first
        var curEnd = clipped[0].second
        for ((s, e) in clipped.drop(1)) {
            if (s <= curEnd) {
                if (e > curEnd) curEnd = e
            } else {
                totalMs += curEnd.toEpochMilli() - curStart.toEpochMilli()
                curStart = s
                curEnd = e
            }
        }
        totalMs += curEnd.toEpochMilli() - curStart.toEpochMilli()
        return Math.round(totalMs / 60_000.0)
    }
}
