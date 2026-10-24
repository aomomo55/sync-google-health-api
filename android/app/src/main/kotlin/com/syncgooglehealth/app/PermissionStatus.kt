package com.syncgooglehealth.app

// 画面に出す権限の状態を決める純粋な規則。MainActivity から切り出してテストする

// ヘルスコネクトの権限と、画面に出す名前。並びは画面に出す順
private val HEALTH_PERMISSION_LABELS: Map<String, String> = linkedMapOf(
    "android.permission.health.READ_STEPS" to "歩数",
    "android.permission.health.READ_DISTANCE" to "移動距離",
    "android.permission.health.READ_TOTAL_CALORIES_BURNED" to "消費カロリー",
    "android.permission.health.READ_EXERCISE" to "運動",
    "android.permission.health.READ_HEART_RATE" to "心拍数",
    "android.permission.health.READ_RESTING_HEART_RATE" to "安静時心拍数",
    "android.permission.health.READ_WEIGHT" to "体重",
    "android.permission.health.READ_BODY_FAT" to "体脂肪率",
    "android.permission.health.READ_SLEEP" to "睡眠",
    PermissionPolicy.READ_NUTRITION to "栄養",
    PermissionPolicy.READ_IN_BACKGROUND to "バックグラウンドでの読み取り",
    PermissionPolicy.READ_HISTORY to "履歴（30 日より前の読み取り）",
)

// permissions の名前を画面に出す順で返す。名前を決めていない権限は、そのままの文字列で末尾に並べる
fun permissionLabels(permissions: Set<String>): List<String> =
    HEALTH_PERMISSION_LABELS.filterKeys { it in permissions }.values.toList() +
        (permissions - HEALTH_PERMISSION_LABELS.keys).sorted()

// 「権限を付与」で求める権限。履歴の権限を使えない端末では求めない
fun requestablePermissions(all: Set<String>, historyAvailable: Boolean): Set<String> =
    if (historyAvailable) all else all - PermissionPolicy.READ_HISTORY

// 足りない権限を、送信に必須のものと任意のもの（栄養・履歴）に分けたもの
data class HealthPermissionStatus(val missingRequired: List<String>, val missingOptional: List<String>)

fun healthPermissionStatus(all: Set<String>, granted: Set<String>, historyAvailable: Boolean): HealthPermissionStatus {
    val missing = requestablePermissions(all, historyAvailable) - granted
    val required = PermissionPolicy.required(all, requireBackground = true)
    return HealthPermissionStatus(
        missingRequired = permissionLabels(missing intersect required),
        missingOptional = permissionLabels(missing - required),
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
