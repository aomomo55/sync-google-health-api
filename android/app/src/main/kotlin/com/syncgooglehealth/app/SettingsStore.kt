package com.syncgooglehealth.app

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

const val DEFAULT_SERVER_URL = ""

// 保存済みトークンの読み出し結果
sealed interface StoredToken {
    data object None : StoredToken
    data class Available(val token: String) : StoredToken {
        // 誤ってログや例外の文に出してもトークンが漏れないようにする
        override fun toString(): String = "Available(***)"
    }

    // Keystore の一時的な不調などで今は読めないが、保存データは残している
    data object Unavailable : StoredToken
}

// 保存データ自体が壊れていて、時間をおいても復号できないことを示す (Base64 の不正、長さ不足など)
class UnusableStoredTokenException(message: String, cause: Throwable? = null) : Exception(message, cause)

// 保存データを消してよい (二度と復号できない) 例外か。それ以外は一時的な失敗とみなして消さない
fun isUnusableStoredTokenError(e: Throwable): Boolean =
    e is javax.crypto.AEADBadTagException ||
        e is java.security.UnrecoverableKeyException ||
        e is UnusableStoredTokenException

// 保存済みの暗号文を復号する。確実に使えない暗号文 (鍵が失われた、別の端末から移った等) だけを消し、
// 未設定として扱って再入力を促す。一時的な失敗では消さずに Unavailable を返す。
// discard には読んだ暗号文を渡す (その間に新しいトークンが保存されていたら消さないため)
fun readStoredTokenState(stored: String?, decrypt: (String) -> String, discard: (String) -> Unit): StoredToken {
    if (stored == null) return StoredToken.None
    val token = try {
        decrypt(stored)
    } catch (e: Exception) {
        if (!isUnusableStoredTokenError(e)) return StoredToken.Unavailable
        null
    }
    if (token.isNullOrEmpty()) {
        discard(stored)
        return StoredToken.None
    }
    return StoredToken.Available(token)
}

// 現在の値が expected のままのときだけ消す。消したら true
fun removeIfUnchanged(current: () -> String?, expected: String, remove: () -> Unit): Boolean {
    if (current() != expected) return false
    remove()
    return true
}

// トークンを Keystore の AES-GCM 鍵で暗号化して保存する。ログには出さない。
class SettingsStore(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("settings", Context.MODE_PRIVATE)

    var serverUrl: String
        get() = prefs.getString(KEY_URL, DEFAULT_SERVER_URL) ?: DEFAULT_SERVER_URL
        set(v) = prefs.edit().putString(KEY_URL, v.trim()).apply()

    // 保存済みとして扱えるときに true。確実に使えないデータは読み出し時に消えるので false になる。
    // 一時的に復号できないだけのときは、再入力を促さないよう「保存済み」とみなす
    fun hasToken(): Boolean = readToken() != StoredToken.None

    fun readToken(): StoredToken = readStoredTokenState(
        stored = prefs.getString(KEY_TOKEN, null),
        decrypt = { enc -> decrypt(enc) },
        discard = { enc ->
            synchronized(LOCK) {
                removeIfUnchanged(
                    current = { prefs.getString(KEY_TOKEN, null) },
                    expected = enc,
                    remove = { prefs.edit().remove(KEY_TOKEN).apply() },
                )
            }
        },
    )

    private fun decrypt(enc: String): String {
        val raw = try {
            Base64.decode(enc, Base64.NO_WRAP)
        } catch (e: IllegalArgumentException) {
            throw UnusableStoredTokenException("Base64 として不正です", e)
        }
        // IV と GCM のタグ (16 バイト) を含まない長さは壊れている
        if (raw.size < IV_SIZE + TAG_BYTES) throw UnusableStoredTokenException("暗号文が短すぎます")
        val iv = raw.copyOfRange(0, IV_SIZE)
        val cipher = Cipher.getInstance(TRANSFORM)
        try {
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(TAG_BYTES * 8, iv))
        } catch (e: KeyPermanentlyInvalidatedException) {
            throw UnusableStoredTokenException("鍵が無効になりました", e)
        }
        return String(cipher.doFinal(raw, IV_SIZE, raw.size - IV_SIZE), Charsets.UTF_8)
    }

    fun saveToken(token: String) {
        val cipher = Cipher.getInstance(TRANSFORM)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val out = cipher.iv + cipher.doFinal(token.toByteArray(Charsets.UTF_8))
        synchronized(LOCK) {
            prefs.edit().putString(KEY_TOKEN, Base64.encodeToString(out, Base64.NO_WRAP)).apply()
        }
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
        private const val TAG_BYTES = 16

        // 保存と「読んだ暗号文のままなら消す」を排他にする (SettingsStore は画面とワーカーで別々に作られる)
        private val LOCK = Any()

        // 制御文字を含むトークンはヘッダーとして不正なので保存前に弾く
        fun isValidToken(t: String): Boolean = t.isNotEmpty() && t.none { it.code < 0x20 || it.code == 0x7f }
    }
}
