package com.syncgooglehealth.app

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

const val DEFAULT_SERVER_URL = ""

// 保存済みの暗号文を復号する。復号できない暗号文 (鍵が失われた、別の端末から移った等) は
// 残しておいても使えないので消し、未設定として扱って再入力を促す
fun readStoredToken(stored: String?, decrypt: (String) -> String, discard: () -> Unit): String? {
    if (stored == null) return null
    val token = try {
        decrypt(stored)
    } catch (_: Exception) {
        null
    }
    if (token.isNullOrEmpty()) {
        discard()
        return null
    }
    return token
}

// トークンを Keystore の AES-GCM 鍵で暗号化して保存する。ログには出さない。
class SettingsStore(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("settings", Context.MODE_PRIVATE)

    var serverUrl: String
        get() = prefs.getString(KEY_URL, DEFAULT_SERVER_URL) ?: DEFAULT_SERVER_URL
        set(v) = prefs.edit().putString(KEY_URL, v.trim()).apply()

    // 保存されているだけでなく、実際に復号できるときに true
    fun hasToken(): Boolean = loadToken() != null

    fun loadToken(): String? = readStoredToken(
        stored = prefs.getString(KEY_TOKEN, null),
        decrypt = { enc ->
            val raw = Base64.decode(enc, Base64.NO_WRAP)
            val iv = raw.copyOfRange(0, IV_SIZE)
            val cipher = Cipher.getInstance(TRANSFORM)
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv))
            String(cipher.doFinal(raw, IV_SIZE, raw.size - IV_SIZE), Charsets.UTF_8)
        },
        discard = { prefs.edit().remove(KEY_TOKEN).apply() },
    )

    fun saveToken(token: String) {
        val cipher = Cipher.getInstance(TRANSFORM)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val out = cipher.iv + cipher.doFinal(token.toByteArray(Charsets.UTF_8))
        prefs.edit().putString(KEY_TOKEN, Base64.encodeToString(out, Base64.NO_WRAP)).apply()
    }

    var lastSyncMillis: Long
        get() = prefs.getLong(KEY_LAST_TIME, 0L)
        set(v) = prefs.edit().putLong(KEY_LAST_TIME, v).apply()

    var lastResult: String
        get() = prefs.getString(KEY_LAST_RESULT, "") ?: ""
        set(v) = prefs.edit().putString(KEY_LAST_RESULT, v).apply()

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return gen.generateKey()
    }

    companion object {
        private const val KEY_URL = "server_url"
        private const val KEY_TOKEN = "token_enc"
        private const val KEY_LAST_TIME = "last_sync_millis"
        private const val KEY_LAST_RESULT = "last_result"
        private const val KEY_ALIAS = "api_token_key"
        private const val TRANSFORM = "AES/GCM/NoPadding"
        private const val IV_SIZE = 12

        // 制御文字を含むトークンはヘッダーとして不正なので保存前に弾く
        fun isValidToken(t: String): Boolean = t.isNotEmpty() && t.none { it.code < 0x20 || it.code == 0x7f }
    }
}
