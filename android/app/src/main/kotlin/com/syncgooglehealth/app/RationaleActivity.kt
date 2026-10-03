package com.syncgooglehealth.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

// 権限の理由説明 (ACTION_SHOW_PERMISSIONS_RATIONALE / VIEW_PERMISSION_USAGE) 用の画面
class RationaleActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme {
                Surface(Modifier.fillMaxSize()) {
                    Column(Modifier.verticalScroll(rememberScrollState()).padding(16.dp)) {
                        Text("読み取るデータと送信先", style = MaterialTheme.typography.headlineSmall)
                        Text(
                            "\nこのアプリはヘルスコネクトから次のデータを読み取ります。\n\n" +
                                "・歩数、移動距離、消費カロリー\n" +
                                "・運動セッション (運動時間の算出に使用)\n" +
                                "・心拍数、安静時心拍数\n" +
                                "・体重、体脂肪率\n" +
                                "・睡眠セッション\n\n" +
                                "読み取ったデータは日ごとに集計し、あなた自身が設定したサーバー " +
                                "へ HTTPS で送信します。" +
                                "それ以外の第三者には送信せず、広告や解析にも使いません。\n\n" +
                                "「バックグラウンドでのデータ読み取り」は、アプリを開いていなくても " +
                                "6 時間ごとに直近 7 日分を自動送信するために使います。\n\n" +
                                "API トークンは端末の Keystore で暗号化して保存します。" +
                                "権限はヘルスコネクトの設定からいつでも取り消せます。",
                        )
                    }
                }
            }
        }
    }
}
