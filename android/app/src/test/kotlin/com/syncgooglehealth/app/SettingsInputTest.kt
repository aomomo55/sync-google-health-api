package com.syncgooglehealth.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// トークンの検査は server/test/config.test.ts の API_TOKEN の検査と同じ入力で確かめる
class TokenValidationTest {
    private val body = "s".repeat(32)

    @Test
    fun acceptsPrintableAscii() {
        assertTrue(isValidToken("Ab0._~+/-${"x".repeat(24)}=="))
    }

    @Test
    fun rejectsEmpty() {
        assertFalse(isValidToken(""))
    }

    @Test
    fun rejectsControlCharacters() {
        assertFalse(isValidToken("\u001b[200~$body"))
        assertFalse(isValidToken("$body\n"))
        assertFalse(isValidToken("$body\u007f"))
    }

    @Test
    fun rejectsSpaces() {
        assertFalse(isValidToken("${"s".repeat(16)} ${"s".repeat(16)}"))
    }

    @Test
    fun rejectsZeroWidthSpace() {
        assertFalse(isValidToken("${"s".repeat(16)}​${"s".repeat(16)}"))
    }

    @Test
    fun rejectsFullWidthCharacters() {
        assertFalse(isValidToken("${body}ａ"))
        assertFalse(isValidToken("${"s".repeat(16)}　${"s".repeat(16)}"))
    }
}

class SettingsValidationTest {
    private val token = "t".repeat(32)
    private fun input(
        serverUrl: String = " https://example.com ",
        token: String = "",
        start: String = "8",
        end: String = "12",
    ) = SettingsInput(serverUrl, token, start, end)

    @Test
    fun validInputIsTrimmedAndKeepsSavedTokenWhenEmpty() {
        assertEquals(
            SettingsValidation.Valid(ValidSettings("https://example.com", null, SleepCheckWindow(8, 12))),
            validateSettings(input(token = "  ")),
        )
    }

    @Test
    fun validInputCarriesTrimmedToken() {
        val result = validateSettings(input(token = " $token "))
        assertEquals(token, (result as SettingsValidation.Valid).settings.token)
    }

    @Test
    fun rejectsNonHttpsUrl() {
        assertEquals(
            SettingsValidation.Invalid(R.string.settings_error_server_url_scheme),
            validateSettings(input(serverUrl = "http://example.com", token = token)),
        )
    }

    @Test
    fun rejectsInvalidToken() {
        assertEquals(
            SettingsValidation.Invalid(R.string.settings_error_token_invalid_chars),
            validateSettings(input(token = "${token}​")),
        )
    }

    // 以前はトークンを保存した後で時間帯の誤りを見つけていた。検証だけで誤りを返し、保存する値を返さない
    @Test
    fun rejectsSleepWindowEvenWhenTokenIsValid() {
        assertEquals(
            SettingsValidation.Invalid(R.string.settings_error_sleep_window),
            validateSettings(input(token = token, start = "12", end = "8")),
        )
    }

    @Test
    fun toStringDoesNotRevealToken() {
        assertFalse(input(token = token).toString().contains(token))
        val result = validateSettings(input(token = token)) as SettingsValidation.Valid
        assertFalse(result.settings.toString().contains(token))
    }
}
