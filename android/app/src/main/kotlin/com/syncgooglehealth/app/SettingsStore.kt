package com.syncgooglehealth.app

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import java.time.LocalDate
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

    // 送信の履歴 (画面の表示と失敗の通知に使う)
    fun syncHistory(): SyncHistory = SyncHistory(
        lastAttemptMillis = prefs.getLong(KEY_LAST_TIME, 0L).takeIf { it != 0L },
        lastSuccessMillis = prefs.getLong(KEY_LAST_SUCCESS, 0L).takeIf { it != 0L },
        lastResult = prefs.getString(KEY_LAST_RESULT, null)?.ifEmpty { null },
        lastWarning = prefs.getString(KEY_LAST_WARNING, null)?.ifEmpty { null },
        failureStreak = prefs.getInt(KEY_FAILURE_COUNT, 0).takeIf { it > 0 }?.let {
            FailureStreak(prefs.getLong(KEY_FAILURE_SINCE, 0L), it)
        },
    )

    // 送信を試した結果を保存する。成功した時刻は、成功したときだけ更新する
    fun recordSync(nowMillis: Long, message: String, succeeded: Boolean, streak: FailureStreak?, warning: String? = null) {
        val edit = prefs.edit()
            .putLong(KEY_LAST_TIME, nowMillis)
            .putString(KEY_LAST_RESULT, message)
            .putString(KEY_LAST_WARNING, warning)
            .putLong(KEY_FAILURE_SINCE, streak?.sinceMillis ?: 0L)
            .putInt(KEY_FAILURE_COUNT, streak?.count ?: 0)
        if (succeeded) edit.putLong(KEY_LAST_SUCCESS, nowMillis)
        edit.apply()
    }

    // 送信の失敗を最後に通知した日 (1 日 1 回にするため)
    var lastSyncFailureNotified: LocalDate?
        get() = prefs.getString(KEY_FAILURE_NOTIFIED, null)?.let { runCatching { LocalDate.parse(it) }.getOrNull() }
        set(v) = prefs.edit().putString(KEY_FAILURE_NOTIFIED, v?.toString()).apply()

    // 睡眠の未反映を通知する時間帯。保存値が不正なら既定値に戻す
    var sleepCheckWindow: SleepCheckWindow
        get() {
            val start = prefs.getInt(KEY_SLEEP_CHECK_START, SleepCheckWindow.DEFAULT_START_HOUR)
            val end = prefs.getInt(KEY_SLEEP_CHECK_END, SleepCheckWindow.DEFAULT_END_HOUR)
            return if (SleepCheckWindow.isValid(start, end)) SleepCheckWindow(start, end) else SleepCheckWindow.DEFAULT
        }
        set(v) = prefs.edit().putInt(KEY_SLEEP_CHECK_START, v.startHour).putInt(KEY_SLEEP_CHECK_END, v.endHour).apply()

    // 睡眠の未反映を最後に通知した日 (利用者が消した通知を、その日のうちに出し直さないため)
    var lastMissingSleepNotified: LocalDate?
        get() = prefs.getString(KEY_MISSING_SLEEP_NOTIFIED, null)?.let { runCatching { LocalDate.parse(it) }.getOrNull() }
        set(v) = prefs.edit().putString(KEY_MISSING_SLEEP_NOTIFIED, v?.toString()).apply()

    // 通知の権限を一度でも求めたか。2 回拒否されてダイアログが出なくなった状態を見分けるのに使う
    var notificationPermissionRequested: Boolean
        get() = prefs.getBoolean(KEY_NOTIFICATION_REQUESTED, false)
        set(v) = prefs.edit().putBoolean(KEY_NOTIFICATION_REQUESTED, v).apply()

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
        // 最後に試した時刻。成功・失敗に関係なく更新する (キーの名前は以前の版のまま)
        private const val KEY_LAST_TIME = "last_sync_millis"
        private const val KEY_LAST_SUCCESS = "last_success_millis"
        private const val KEY_FAILURE_SINCE = "failure_since_millis"
        private const val KEY_FAILURE_COUNT = "failure_count"
        private const val KEY_FAILURE_NOTIFIED = "sync_failure_notified_date"
        private const val KEY_MISSING_SLEEP_NOTIFIED = "missing_sleep_notified_date"
        private const val KEY_SLEEP_CHECK_START = "sleep_check_start_hour"
        private const val KEY_SLEEP_CHECK_END = "sleep_check_end_hour"
        private const val KEY_LAST_RESULT = "last_result"
        private const val KEY_LAST_WARNING = "last_warning"
        private const val KEY_NOTIFICATION_REQUESTED = "notification_permission_requested"
        private const val KEY_ALIAS = "api_token_key"
        private const val TRANSFORM = "AES/GCM/NoPadding"
        private const val IV_SIZE = 12
        private const val TAG_BYTES = 16

        // 保存と「読んだ暗号文のままなら消す」を排他にする (SettingsStore は画面とワーカーで別々に作られる)
        private val LOCK = Any()
    }
}
