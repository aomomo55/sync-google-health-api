package com.syncgooglehealth.app

import android.content.Context
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.BodyFatRecord
import androidx.health.connect.client.records.DistanceRecord
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.NutritionRecord
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.RestingHeartRateRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.TotalCaloriesBurnedRecord
import androidx.health.connect.client.records.WeightRecord
import androidx.health.connect.client.request.AggregateGroupByDurationRequest
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import java.time.LocalDate
import java.time.LocalTime
import kotlin.reflect.KClass

object HealthPermissions {
    val all: Set<String> = setOf(
        HealthPermission.getReadPermission(StepsRecord::class),
        HealthPermission.getReadPermission(DistanceRecord::class),
        HealthPermission.getReadPermission(TotalCaloriesBurnedRecord::class),
        HealthPermission.getReadPermission(ExerciseSessionRecord::class),
        HealthPermission.getReadPermission(HeartRateRecord::class),
        HealthPermission.getReadPermission(RestingHeartRateRecord::class),
        HealthPermission.getReadPermission(WeightRecord::class),
        HealthPermission.getReadPermission(BodyFatRecord::class),
        HealthPermission.getReadPermission(SleepSessionRecord::class),
        HealthPermission.getReadPermission(NutritionRecord::class),
        HealthPermission.PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND,
        HealthPermission.PERMISSION_READ_HEALTH_DATA_HISTORY,
    )

    fun contract() = PermissionController.createRequestPermissionResultContract()
}

// 1 回の readRecords で受け取る件数
private const val PAGE_SIZE = 1000

// 睡眠を読む範囲の区切りの時刻。前日の正午から翌日の正午までを読み、起床した日に振り分ける
private val SLEEP_WINDOW_BOUNDARY: LocalTime = LocalTime.NOON

class HealthReader(context: Context) {
    private val client = HealthConnectClient.getOrCreate(context)

    suspend fun grantedPermissions(): Set<String> = client.permissionController.getGrantedPermissions()

    // [from, to] の各日を DailySummary にする (データのない日は含めない)
    // includeNutrition: 栄養の権限があるときだけ true (権限が無い指標を要求すると例外になる)
    suspend fun readDays(from: LocalDate, to: LocalDate, includeNutrition: Boolean = false): List<DailySummary> {
        // 暦日 (Asia/Tokyo) の範囲。集計も記録の読み取りも、この同じ範囲で区切る
        val instantFilter = TimeRangeFilter.between(startOfCalendarDay(from), startOfCalendarDay(to.plusDays(1)))

        // Period で区切る集計は記録ごとのオフセットで日を分け、端末のタイムゾーンで記録したものは日本時間の暦日とずれる。
        // そこで日本時間の 0 時を起点に、Instant の範囲を 24 時間ずつ区切って集計する。
        // データの無い日は結果に含まれない
        val aggregates = client.aggregateGroupByDuration(
            AggregateGroupByDurationRequest(
                metrics = baseMetrics + if (includeNutrition) nutritionMetrics else emptySet(),
                timeRangeFilter = instantFilter,
                timeRangeSlicer = CALENDAR_DAY_LENGTH,
            ),
        ).associateBy { calendarDateOf(it.startTime) }

        val exercise = readAll(ExerciseSessionRecord::class, instantFilter)
        val bodyFat = readAll(BodyFatRecord::class, instantFilter)

        val sleepFilter = TimeRangeFilter.between(
            from.minusDays(1).atTime(SLEEP_WINDOW_BOUNDARY).atZone(CALENDAR_ZONE).toInstant(),
            to.plusDays(1).atTime(SLEEP_WINDOW_BOUNDARY).atZone(CALENDAR_ZONE).toInstant(),
        )
        val sleepInputs = readAll(SleepSessionRecord::class, sleepFilter).map { r ->
            SleepSessionInput(
                origin = r.metadata.dataOrigin.packageName,
                start = r.startTime,
                end = r.endTime,
                stages = r.stages.map { SleepStage(it.stage, it.startTime, it.endTime) },
            )
        }
        val sleepByDate = SleepAssigner.assign(sleepInputs, CALENDAR_ZONE)

        val spans = exercise.map {
            ExerciseSpan(it.startTime, it.endTime, it.exerciseType == ExerciseSessionRecord.EXERCISE_TYPE_WALKING)
        }
        val lastBodyFatByDate = bodyFat
            .sortedBy { it.time }
            .associate { calendarDateOf(it.time) to it.percentage.value }

        return from.datesUntil(to.plusDays(1)).toList().map { date ->
            val agg = aggregates[date]
            val raw = RawDay(
                steps = agg?.result?.get(StepsRecord.COUNT_TOTAL),
                distanceM = agg?.result?.get(DistanceRecord.DISTANCE_TOTAL)?.inMeters,
                caloriesKcal = agg?.result?.get(TotalCaloriesBurnedRecord.ENERGY_TOTAL)?.inKilocalories,
                hrAvg = agg?.result?.get(HeartRateRecord.BPM_AVG)?.toDouble(),
                hrMax = agg?.result?.get(HeartRateRecord.BPM_MAX),
                hrMin = agg?.result?.get(HeartRateRecord.BPM_MIN),
                restingBpm = agg?.result?.get(RestingHeartRateRecord.BPM_AVG),
                weightKg = agg?.result?.get(WeightRecord.WEIGHT_AVG)?.inKilograms,
                bodyFatPct = lastBodyFatByDate[date],
                energyKcal = agg?.result?.get(NutritionRecord.ENERGY_TOTAL)?.inKilocalories,
                proteinG = agg?.result?.get(NutritionRecord.PROTEIN_TOTAL)?.inGrams,
                fatG = agg?.result?.get(NutritionRecord.TOTAL_FAT_TOTAL)?.inGrams,
                carbsG = agg?.result?.get(NutritionRecord.TOTAL_CARBOHYDRATE_TOTAL)?.inGrams,
                exercise = spans,
            )
            DayAggregator.build(date, CALENDAR_ZONE, raw, sleepByDate[date])
        }.filter { it.hasData() }
    }

    private val baseMetrics = setOf(
        StepsRecord.COUNT_TOTAL,
        DistanceRecord.DISTANCE_TOTAL,
        TotalCaloriesBurnedRecord.ENERGY_TOTAL,
        HeartRateRecord.BPM_AVG,
        HeartRateRecord.BPM_MAX,
        HeartRateRecord.BPM_MIN,
        RestingHeartRateRecord.BPM_AVG,
        WeightRecord.WEIGHT_AVG,
    )

    private val nutritionMetrics = setOf(
        NutritionRecord.ENERGY_TOTAL,
        NutritionRecord.PROTEIN_TOTAL,
        NutritionRecord.TOTAL_FAT_TOTAL,
        NutritionRecord.TOTAL_CARBOHYDRATE_TOTAL,
    )

    private suspend fun <T : Record> readAll(type: KClass<T>, filter: TimeRangeFilter): List<T> {
        val out = mutableListOf<T>()
        // ページ送りのトークンを更新しながら繰り返すため var
        var token: String? = null
        do {
            val res = client.readRecords(ReadRecordsRequest(type, filter, pageSize = PAGE_SIZE, pageToken = token))
            out += res.records
            token = res.pageToken
        } while (token != null)
        return out
    }
}
