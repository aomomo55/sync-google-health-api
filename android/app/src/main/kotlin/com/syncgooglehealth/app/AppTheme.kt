package com.syncgooglehealth.app

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable

// 端末のダークモードに合わせる。画面の端まで描くので、ステータスバーのアイコンの色（enableEdgeToEdge が
// 端末の設定から決める）と背景の明るさをそろえないと、時計などが見えなくなる
@Composable
fun AppTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = if (isSystemInDarkTheme()) darkColorScheme() else lightColorScheme(), content = content)
}
