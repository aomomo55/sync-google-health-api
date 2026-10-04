package com.syncgooglehealth.app

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

// サーバーの ingest スキーマ (strict) に合わせた送信用モデル。null のフィールドは出力しない。
@Serializable
data class ActivitySummary(
    val steps: Long? = null,
    @SerialName("distance_m") val distanceM: Double? = null,
    @SerialName("calories_kcal") val caloriesKcal: Double? = null,
    @SerialName("move_minutes") val moveMinutes: Long? = null,
    @SerialName("walking_minutes") val walkingMinutes: Long? = null,
) {
    fun isEmpty() = steps == null && distanceM == null && caloriesKcal == null &&
        moveMinutes == null && walkingMinutes == null
}

@Serializable
data class HeartRateSummary(
    @SerialName("avg_bpm") val avgBpm: Double? = null,
    @SerialName("max_bpm") val maxBpm: Long? = null,
    @SerialName("min_bpm") val minBpm: Long? = null,
    @SerialName("resting_bpm") val restingBpm: Long? = null,
) {
    fun isEmpty() = avgBpm == null && maxBpm == null && minBpm == null && restingBpm == null
}

@Serializable
data class BodySummary(
    @SerialName("weight_kg") val weightKg: Double? = null,
    @SerialName("body_fat_pct") val bodyFatPct: Double? = null,
) {
    fun isEmpty() = weightKg == null && bodyFatPct == null
}

@Serializable
data class NutritionSummary(
    @SerialName("energy_kcal") val energyKcal: Long? = null,
    @SerialName("protein_g") val proteinG: Double? = null,
    @SerialName("fat_g") val fatG: Double? = null,
    @SerialName("carbs_g") val carbsG: Double? = null,
) {
    fun isEmpty() = energyKcal == null && proteinG == null && fatG == null && carbsG == null
}

@Serializable
data class SleepSummary(
    val start: String,
    val end: String,
    @SerialName("asleep_minutes") val asleepMinutes: Long,
    @SerialName("in_bed_minutes") val inBedMinutes: Long,
    @SerialName("awake_minutes") val awakeMinutes: Long? = null,
    @SerialName("deep_minutes") val deepMinutes: Long? = null,
    @SerialName("light_minutes") val lightMinutes: Long? = null,
    @SerialName("rem_minutes") val remMinutes: Long? = null,
    @SerialName("nap_minutes") val napMinutes: Long? = null,
)

@Serializable
data class DailySummary(
    val date: String,
    val activity: ActivitySummary? = null,
    @SerialName("heart_rate") val heartRate: HeartRateSummary? = null,
    val body: BodySummary? = null,
    val sleep: SleepSummary? = null,
    val nutrition: NutritionSummary? = null,
    val source: String = "health_connect",
) {
    fun hasData() = activity != null || heartRate != null || body != null || sleep != null ||
        nutrition != null
}

@Serializable
data class IngestRequest(val days: List<DailySummary>)

// null は出力せず、デフォルト値 (source) は必ず出力する
val ingestJson = Json {
    explicitNulls = false
    encodeDefaults = true
}
