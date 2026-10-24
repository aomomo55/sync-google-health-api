package com.syncgooglehealth.app

// 画面に出す権限の状態を決める純粋な規則。MainActivity から切り出してテストする

// ヘルスコネクトの権限と、画面に出す名前。並びは画面に出す順
private val HEALTH_PERMISSION_LABELS: Map<String, Int> = linkedMapOf(
    "android.permission.health.READ_STEPS" to R.string.permission_label_steps,
    "android.permission.health.READ_DISTANCE" to R.string.permission_label_distance,
    "android.permission.health.READ_TOTAL_CALORIES_BURNED" to R.string.permission_label_calories_burned,
    "android.permission.health.READ_EXERCISE" to R.string.permission_label_exercise,
    "android.permission.health.READ_HEART_RATE" to R.string.permission_label_heart_rate,
    "android.permission.health.READ_RESTING_HEART_RATE" to R.string.permission_label_resting_heart_rate,
    "android.permission.health.READ_WEIGHT" to R.string.permission_label_weight,
    "android.permission.health.READ_BODY_FAT" to R.string.permission_label_body_fat,
    "android.permission.health.READ_SLEEP" to R.string.permission_label_sleep,
    PermissionPolicy.READ_NUTRITION to R.string.permission_label_nutrition,
    PermissionPolicy.READ_IN_BACKGROUND to R.string.permission_label_background_read,
    PermissionPolicy.READ_HISTORY to R.string.permission_label_history,
)

// permissions の名前を画面に出す順で返す。名前を決めていない権限は、そのままの文字列で末尾に並べる
fun permissionLabels(texts: Texts, permissions: Set<String>): List<String> =
    HEALTH_PERMISSION_LABELS.filterKeys { it in permissions }.values.map { texts.get(it) } +
        (permissions - HEALTH_PERMISSION_LABELS.keys).sorted()

// 「権限を付与」で求める権限。履歴の権限を使えない端末では求めない
fun requestablePermissions(all: Set<String>, historyAvailable: Boolean): Set<String> =
    if (historyAvailable) all else all - PermissionPolicy.READ_HISTORY

// 足りない権限を、送信に必須のものと任意のもの（栄養・履歴）に分けたもの
data class HealthPermissionStatus(val missingRequired: List<String>, val missingOptional: List<String>)

fun healthPermissionStatus(texts: Texts, all: Set<String>, granted: Set<String>, historyAvailable: Boolean): HealthPermissionStatus {
    val missing = requestablePermissions(all, historyAvailable) - granted
    val required = PermissionPolicy.required(all, requireBackground = true)
    return HealthPermissionStatus(
        missingRequired = permissionLabels(texts, missing intersect required),
        missingOptional = permissionLabels(texts, missing - required),
    )
}

enum class NotificationPermissionState {
    GRANTED,

    // 許可のダイアログを出せる
    REQUESTABLE,

    // 2 回拒否されて OS がダイアログを出さない。アプリの通知設定から許可してもらう
    BLOCKED,
}

// shouldShowRationale (shouldShowRequestPermissionRationale) は、まだ一度も求めていないときと、
// 2 回拒否されたあとのどちらでも false になる。一度でも求めたかどうかと合わせて見分ける
fun notificationPermissionState(granted: Boolean, requestedBefore: Boolean, shouldShowRationale: Boolean): NotificationPermissionState =
    when {
        granted -> NotificationPermissionState.GRANTED
        !requestedBefore || shouldShowRationale -> NotificationPermissionState.REQUESTABLE
        else -> NotificationPermissionState.BLOCKED
    }
