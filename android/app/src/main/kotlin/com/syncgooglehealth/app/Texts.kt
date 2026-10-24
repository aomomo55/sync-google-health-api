package com.syncgooglehealth.app

import android.content.Context
import androidx.annotation.StringRes

// 利用者に見せる文言を strings.xml から引く入口。
// Worker・通知・結果の文を作る関数など、Compose の外で使う。
// 関数に Context を持ち込まずに済み、単体テストでは別の実装に差し替えられる
interface Texts {
    fun get(@StringRes id: Int, vararg args: Any): String
}

class ContextTexts(private val context: Context) : Texts {
    override fun get(@StringRes id: Int, vararg args: Any): String =
        if (args.isEmpty()) context.getString(id) else context.getString(id, *args)
}
