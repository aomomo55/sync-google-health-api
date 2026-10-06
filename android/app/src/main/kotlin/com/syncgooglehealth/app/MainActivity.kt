package com.syncgooglehealth.app

import android.content.Context
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.SelectableDates
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.HealthConnectFeatures
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset

// 画面回転でも実行状態を失わないようにプロセス単位で保持する
object AppState {
    val running = MutableStateFlow(false)
    val lastTime = MutableStateFlow<Long?>(null)
    val lastResult = MutableStateFlow<String?>(null)
    val progress = MutableStateFlow<String?>(null)
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    fun start(context: Context, days: Int, startDate: LocalDate? = null) {
        if (!running.compareAndSet(false, true)) return
        val app = context.applicationContext
        scope.launch {
            try {
                progress.value = null
                val outcome = SyncRunner.run(app, days, startDate = startDate, onProgress = { progress.value = it })
                lastResult.value = outcome.message
                lastTime.value = System.currentTimeMillis()
            } finally {
                progress.value = null
                running.value = false
            }
        }
    }
}

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme {
                Surface(Modifier.fillMaxSize()) { MainScreen() }
            }
        }
    }
}

private suspend fun backgroundReadStatus(context: Context): String {
    return try {
        val client = HealthConnectClient.getOrCreate(context)
        if (client.features.getFeatureStatus(HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_IN_BACKGROUND)
            == HealthConnectFeatures.FEATURE_STATUS_AVAILABLE
        ) "バックグラウンド読み取り: 利用可能" else "バックグラウンド読み取り: この端末では利用できません (自動送信は動作しません)"
    } catch (e: Exception) {
        "バックグラウンド読み取り: 確認できませんでした"
    }
}

// 履歴の権限（30 日より前の読み取り） を使える端末か。確認できないときは使えないものとして扱う
private suspend fun historyFeatureAvailable(context: Context): Boolean {
    return try {
        HealthConnectClient.getOrCreate(context).features.getFeatureStatus(HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_HISTORY) ==
            HealthConnectFeatures.FEATURE_STATUS_AVAILABLE
    } catch (e: Exception) {
        false
    }
}

// 開始日として選べるのは、今日から MAX_START_DAYS_BACK 日前まで。DatePicker の日付は UTC の 0 時で渡される
private class StartDates(private val today: LocalDate) : SelectableDates {
    override fun isSelectableDate(utcTimeMillis: Long): Boolean =
        isSelectableStart(Instant.ofEpochMilli(utcTimeMillis).atZone(ZoneOffset.UTC).toLocalDate(), today)

    override fun isSelectableYear(year: Int): Boolean = year in earliestSelectableStart(today).year..today.year
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MainScreen() {
    val context = LocalContext.current
    val store = remember { SettingsStore(context) }
    var url by remember { mutableStateOf(store.serverUrl) }
    var token by remember { mutableStateOf("") }
    var tokenSaved by remember { mutableStateOf(store.hasToken()) }
    var message by remember { mutableStateOf<String?>(null) }
    var sdkMessage by remember { mutableStateOf<String?>(null) }
    var bgMessage by remember { mutableStateOf<String?>(null) }
    var granted by remember { mutableStateOf(false) }
    var nutritionGranted by remember { mutableStateOf(true) }
    var historyGranted by remember { mutableStateOf(false) }
    var historyAvailable by remember { mutableStateOf(true) }
    var startDate by remember { mutableStateOf<LocalDate?>(null) }
    var showDatePicker by remember { mutableStateOf(false) }
    var sdkOk by remember { mutableStateOf(false) }

    val running by AppState.running.collectAsState()
    val lastTime by AppState.lastTime.collectAsState()
    val lastResult by AppState.lastResult.collectAsState()
    val progress by AppState.progress.collectAsState()

    suspend fun refresh() {
        when (HealthConnectClient.getSdkStatus(context)) {
            HealthConnectClient.SDK_AVAILABLE -> {
                sdkOk = true
                sdkMessage = null
                val perms = HealthReader(context).grantedPermissions()
                granted = perms.containsAll(PermissionPolicy.required(HealthPermissions.all, true))
                nutritionGranted = PermissionPolicy.canReadNutrition(perms)
                historyGranted = PermissionPolicy.canReadHistory(perms)
                historyAvailable = historyFeatureAvailable(context)
                bgMessage = backgroundReadStatus(context)
            }
            HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> {
                sdkOk = false
                sdkMessage = "ヘルスコネクトの更新が必要です。Google Play で更新してください"
            }
            else -> {
                sdkOk = false
                sdkMessage = "この端末ではヘルスコネクトを利用できません"
            }
        }
        // 復号できず消されたトークンを画面にも反映する
        tokenSaved = store.hasToken()
        if (granted && tokenSaved) SyncWorker.schedule(context)
    }

    val launcher = rememberLauncherForActivityResult(HealthPermissions.contract()) { _ ->
        AppState.scope.launch { refresh() }
    }
    LaunchedEffect(Unit) { refresh() }

    // 入力内容を保存する。成功したら true
    fun save(): Boolean {
        val u = url.trim()
        if (!u.startsWith("https://")) {
            message = "サーバー URL は https:// で始まる必要があります"
            return false
        }
        val t = token.trim()
        if (t.isNotEmpty()) {
            if (!SettingsStore.isValidToken(t)) {
                message = "トークンに使えない文字が含まれています"
                return false
            }
            store.saveToken(t)
            tokenSaved = true
            token = ""
        }
        store.serverUrl = u
        if (granted && store.hasToken()) SyncWorker.schedule(context)
        message = "設定を保存しました"
        return true
    }

    val shownTime = lastTime ?: store.lastSyncMillis.takeIf { it != 0L }
    val shownResult = lastResult ?: store.lastResult.ifEmpty { null }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("ヘルス同期", style = MaterialTheme.typography.headlineSmall)

        OutlinedTextField(
            value = url,
            onValueChange = { url = it },
            label = { Text("サーバー URL") },
            placeholder = { Text("https://<your-app>.fly.dev") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = token,
            onValueChange = { token = it },
            label = { Text("API トークン") },
            placeholder = { if (tokenSaved) Text("保存済み (変更する場合のみ入力)") },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedButton(onClick = { save() }, enabled = !running, modifier = Modifier.fillMaxWidth()) {
            Text("設定を保存")
        }
        message?.let { Text(it, color = MaterialTheme.colorScheme.primary) }

        sdkMessage?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        Text(if (granted) "ヘルスコネクトの権限: 付与済み" else "ヘルスコネクトの権限: 未付与または不足")
        if (sdkOk && !nutritionGranted) {
            Text(
                "栄養の権限がありません。摂取カロリーも送るには『権限を付与』を押してください",
                color = MaterialTheme.colorScheme.error,
            )
        }
        bgMessage?.let { Text(it, style = MaterialTheme.typography.bodySmall) }

        Button(
            onClick = { launcher.launch(if (historyAvailable) HealthPermissions.all else HealthPermissions.all - PermissionPolicy.READ_HISTORY) },
            enabled = sdkOk && !running,
            modifier = Modifier.fillMaxWidth(),
        ) { Text("権限を付与") }
        Button(
            onClick = { if (save()) AppState.start(context, 7) },
            enabled = sdkOk && !running,
            modifier = Modifier.fillMaxWidth(),
        ) { Text("今すぐ送信（直近7日）") }
        Button(
            onClick = { if (save()) AppState.start(context, 30) },
            enabled = sdkOk && !running,
            modifier = Modifier.fillMaxWidth(),
        ) { Text("過去30日を送る") }

        val today = LocalDate.now()
        OutlinedButton(
            onClick = { showDatePicker = true },
            enabled = sdkOk && !running,
            modifier = Modifier.fillMaxWidth(),
        ) { Text(startDate?.let { "開始日: $it" } ?: "開始日を選ぶ") }
        Button(
            onClick = { startDate?.let { d -> if (save()) AppState.start(context, countDays(d, today), d) } },
            enabled = sdkOk && !running && startDate != null,
            modifier = Modifier.fillMaxWidth(),
        ) { Text(startDate?.let { "$it から今日まで送る" } ?: "開始日を指定して送る") }
        Text(
            "選べるのは今日から ${MAX_START_DAYS_BACK} 日前まで（${earliestSelectableStart(today)} 以降）。" +
                "それより前は Google Takeout を取り直して import:takeout で取り込んでください",
            style = MaterialTheme.typography.bodySmall,
        )
        val selected = startDate
        if (sdkOk && selected != null && needsHistoryPermission(selected, today) && !historyGranted) {
            Text(
                if (historyAvailable) {
                    "履歴の権限が無いため、権限を許可した日の 30 日前より前のデータは読めません。『権限を付与』で履歴の権限も許可してください"
                } else {
                    "この端末では履歴の権限を使えないため、権限を許可した日の 30 日前より前のデータは読めません"
                },
                color = MaterialTheme.colorScheme.error,
            )
        }

        if (showDatePicker) {
            val pickerState = rememberDatePickerState(
                initialSelectedDateMillis = startDate?.atStartOfDay(ZoneOffset.UTC)?.toInstant()?.toEpochMilli(),
                selectableDates = StartDates(today),
            )
            DatePickerDialog(
                onDismissRequest = { showDatePicker = false },
                confirmButton = {
                    TextButton(onClick = {
                        pickerState.selectedDateMillis?.let {
                            startDate = Instant.ofEpochMilli(it).atZone(ZoneOffset.UTC).toLocalDate()
                        }
                        showDatePicker = false
                    }) { Text("決定") }
                },
                dismissButton = { TextButton(onClick = { showDatePicker = false }) { Text("キャンセル") } },
            ) { DatePicker(state = pickerState) }
        }

        // 送信中に前回の結果（古いエラーなど）が見えると紛らわしいので隠す
        if (running) {
            Text(progress ?: "送信中…")
        } else {
            Text("最終送信: ${SyncRunner.formatTime(shownTime ?: 0L)}")
            shownResult?.let { Text("結果: $it") }
        }

        OutlinedButton(
            onClick = { context.startActivity(Intent(context, RationaleActivity::class.java)) },
            modifier = Modifier.fillMaxWidth(),
        ) { Text("読み取るデータと送信先について") }
    }
}
