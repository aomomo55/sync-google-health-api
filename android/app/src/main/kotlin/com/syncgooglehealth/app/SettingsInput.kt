package com.syncgooglehealth.app

import androidx.annotation.StringRes

// トークンに使える文字。サーバーが API_TOKEN に掛ける文字の規則 (server/src/config.ts の BEARER_TOKEN_PATTERN。
// Hono の bearerAuth が受け付ける文字) と同じで、英数字と . _ ~ + / -、末尾の = だけを許す。
// 制御文字・空白・全角文字・ゼロ幅スペースもこれで弾かれる。制御文字や ASCII 以外の文字は送信のたびに
// OkHttp が例外を投げ、それ以外の記号はサーバーが 400 を返すため、保存前に弾く。
// 長さ (サーバーの MIN_API_TOKEN_LENGTH) は見ない。短い値はサーバーのトークンと一致しないので、
// 送信したときに「トークンが正しくありません」と分かる
private val TOKEN_PATTERN = Regex("[A-Za-z0-9._~+/-]+=*")

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
