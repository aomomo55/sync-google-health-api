package com.syncgooglehealth.app

// 権限のうち「無くても送信を続けられるもの」を決める純粋な規則。
// 栄養は後から追加した権限なので、既存のインストールでは未付与のことがある。
object PermissionPolicy {
    const val READ_NUTRITION = "android.permission.health.READ_NUTRITION"
    const val READ_IN_BACKGROUND = "android.permission.health.READ_HEALTH_DATA_IN_BACKGROUND"

    private val optional = setOf(READ_NUTRITION)

    // 送信に必須の権限 (栄養は含めない)。バックグラウンド読み取りはワーカーのときだけ必須
    fun required(all: Set<String>, requireBackground: Boolean): Set<String> {
        val base = all - optional
        return if (requireBackground) base else base - READ_IN_BACKGROUND
    }

    // 権限が無い指標を集計に含めると例外になるため、付与されているときだけ栄養を読む
    fun canReadNutrition(granted: Set<String>): Boolean = READ_NUTRITION in granted
}
