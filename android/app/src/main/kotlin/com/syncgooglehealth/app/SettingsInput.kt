package com.syncgooglehealth.app

import androidx.annotation.StringRes

// トークンに使える文字。サーバーの API_TOKEN の検査 (server/src/config.ts の token) と同じ規則で、
// 空白・改行・制御文字・全角文字・ゼロ幅スペースなどを弾く。
// 制御文字はヘッダーとして不正で、ASCII 以外の文字は送信のたびに OkHttp が例外を投げるため、保存前に弾く
private val TOKEN_PATTERN = Regex("[\\x21-\\x7e]+")

fun isValidToken(token: String): Boolean = TOKEN_PATTERN.matches(token)

// 画面に入力されたままの設定
data class SettingsInput(
    val serverUrl: String,
    val token: String,
    val sleepCheckStart: String,
    val sleepCheckEnd: String,
) {
    // 誤ってログや例外の文に出してもトークンが漏れないようにする
    override fun toString(): String =
        "SettingsInput(serverUrl=$serverUrl, token=***, sleepCheckStart=$sleepCheckStart, sleepCheckEnd=$sleepCheckEnd)"
}

// 検証を通った、保存する値。token が null なら保存済みのトークンを変えない (入力欄が空のとき)
data class ValidSettings(
    val serverUrl: String,
    val token: String?,
    val sleepCheckWindow: SleepCheckWindow,
) {
    override fun toString(): String =
        "ValidSettings(serverUrl=$serverUrl, token=${token?.let { "***" }}, sleepCheckWindow=$sleepCheckWindow)"
}

sealed interface SettingsValidation {
    data class Valid(val settings: ValidSettings) : SettingsValidation
    data class Invalid(@StringRes val error: Int) : SettingsValidation
}

// 入力をすべて検証する。誤りがあれば最初の誤りの文を返し、何も保存しないで済むようにする
fun validateSettings(input: SettingsInput): SettingsValidation {
    val url = input.serverUrl.trim()
    if (!url.startsWith("https://")) return SettingsValidation.Invalid(R.string.settings_error_server_url_scheme)
    val token = input.token.trim().ifEmpty { null }
    if (token != null && !isValidToken(token)) return SettingsValidation.Invalid(R.string.settings_error_token_invalid_chars)
    val window = SleepCheckWindow.parse(input.sleepCheckStart, input.sleepCheckEnd)
        ?: return SettingsValidation.Invalid(R.string.settings_error_sleep_window)
    return SettingsValidation.Valid(ValidSettings(url, token, window))
}
