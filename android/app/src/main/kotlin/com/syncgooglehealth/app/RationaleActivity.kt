package com.syncgooglehealth.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp

// 権限の理由説明 (ACTION_SHOW_PERMISSIONS_RATIONALE / VIEW_PERMISSION_USAGE) 用の画面
class RationaleActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            AppTheme {
                Surface(Modifier.fillMaxSize()) {
                    // targetSdk 35 以降は画面の端まで描かれるので、ステータスバーなどの分を空ける
                    Column(Modifier.safeDrawingPadding().verticalScroll(rememberScrollState()).padding(16.dp)) {
                        Text(stringResource(R.string.rationale_title), style = MaterialTheme.typography.headlineSmall)
                        Text(stringResource(R.string.rationale_body, SyncWorker.INTERVAL_HOURS, RECENT_SYNC_DAYS))
                    }
                }
            }
        }
    }
}
