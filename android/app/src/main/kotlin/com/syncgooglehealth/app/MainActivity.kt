package com.syncgooglehealth.app

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.LocalActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.safeDrawingPadding
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
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.HealthConnectFeatures
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
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
    val progress = MutableStateFlow<String?>(null)
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    fun start(context: Context, days: Int, startDate: LocalDate? = null) {
        if (!running.compareAndSet(false, true)) return
        val app = context.applicationContext
        scope.launch {
            try {
                progress.value = null
                SyncRunner.run(app, days, startDate = startDate, onProgress = { progress.value = it })
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
        enableEdgeToEdge()
        setContent {
            AppTheme {
                Surface(Modifier.fillMaxSize()) { MainScreen() }
            }
        }
    }
}

// 画面に出す文の種類。問題のある文は、色だけでなく見出し語でも見分けられるようにする
private enum class MessageKind(val prefix: String) {
    INFO(""),
    SUCCESS(""),
    WARNING("注意: "),
    ACTION_NEEDED("要対応: "),
    ERROR("エラー: "),
}

private data class ScreenMessage(val text: String, val kind: MessageKind)

@Composable
private fun MessageText(message: ScreenMessage) {
    val color = when (message.kind) {
        MessageKind.INFO -> Color.Unspecified
        MessageKind.SUCCESS -> MaterialTheme.colorScheme.primary
        MessageKind.WARNING, MessageKind.ACTION_NEEDED, MessageKind.ERROR -> MaterialTheme.colorScheme.error
    }
    Text(message.kind.prefix + message.text, color = color)
}

// 「最後に成功」と「最後に試した」を分けて出す。失敗が続いても時刻だけ新しく見えないようにするため (ADR 0026)
@Composable
private fun SyncHistoryText(history: SyncHistory) {
    val success = history.lastSuccessMillis
    val attempt = history.lastAttemptMillis
    if (success == null && attempt == null) {
        Text("まだ送信していません")
        return
    }
    Text("最後に成功: ${success?.let { SyncRunner.formatTime(it) } ?: "記録なし"}")
    if (attempt != null && attempt != success) {
        Text("最後に試した: ${SyncRunner.formatTime(attempt)}${if (history.lastFailed) "（失敗）" else ""}")
    }
    history.lastResult?.let { result ->
        if (history.lastFailed) MessageText(ScreenMessage(result, MessageKind.ERROR)) else Text("結果: $result")
    }
    if (isSuccessStale(System.currentTimeMillis(), success)) {
        MessageText(
            ScreenMessage(
                "${STALE_SUCCESS_WARNING_HOURS}時間以上、送信に成功していません。自動送信が止まっているか、失敗が続いています。" +
                    "「今すぐ送信」で結果を確かめてください",
                MessageKind.WARNING,
            ),
        )
    }
}

private fun hasNotificationPermission(context: Context): Boolean =
    context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

private suspend fun backgroundReadStatus(context: Context): ScreenMessage {
    return try {
        val client = HealthConnectClient.getOrCreate(context)
        if (client.features.getFeatureStatus(HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_IN_BACKGROUND)
            == HealthConnectFeatures.FEATURE_STATUS_AVAILABLE
        ) {
            ScreenMessage("バックグラウンド読み取り: 利用可能", MessageKind.INFO)
        } else {
            ScreenMessage("この端末ではバックグラウンド読み取りを利用できません (自動送信は動作しません)", MessageKind.WARNING)
        }
    } catch (e: Exception) {
        ScreenMessage("バックグラウンド読み取りを利用できるか確認できませんでした", MessageKind.WARNING)
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

// 開けなかったら false
private fun startActivitySafely(context: Context, intent: Intent): Boolean =
    try {
        context.startActivity(intent)
        true
    } catch (e: ActivityNotFoundException) {
        false
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
    val activity = LocalActivity.current
    val focusManager = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    val scope = rememberCoroutineScope()
    val store = remember { SettingsStore(context) }
    var url by remember { mutableStateOf(store.serverUrl) }
    var token by remember { mutableStateOf("") }
    var tokenSaved by remember { mutableStateOf(store.hasToken()) }
    // 保存の結果は押したボタンの近くに出すため、「設定を保存」と送信のボタンで分けて持つ
    var saveMessage by remember { mutableStateOf<ScreenMessage?>(null) }
    var sendMessage by remember { mutableStateOf<ScreenMessage?>(null) }
    var settingsMessage by remember { mutableStateOf<ScreenMessage?>(null) }
    var sdkMessage by remember { mutableStateOf<ScreenMessage?>(null) }
    var bgMessage by remember { mutableStateOf<ScreenMessage?>(null) }
    var grantedPermissions by remember { mutableStateOf(emptySet<String>()) }
    var historyAvailable by remember { mutableStateOf(true) }
    var startDate by remember { mutableStateOf<LocalDate?>(null) }
    var showDatePicker by remember { mutableStateOf(false) }
    var sdkOk by remember { mutableStateOf(false) }
    fun currentNotificationState(): NotificationPermissionState = notificationPermissionState(
        granted = hasNotificationPermission(context),
        requestedBefore = store.notificationPermissionRequested,
        shouldShowRationale = activity?.shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS) ?: false,
    )
    var notificationState by remember { mutableStateOf(currentNotificationState()) }
    val initialWindow = remember { store.sleepCheckWindow }
    var checkStart by remember { mutableStateOf(initialWindow.startHour.toString()) }
    var checkEnd by remember { mutableStateOf(initialWindow.endHour.toString()) }

    val running by AppState.running.collectAsState()
    // 送信の結果は SyncRunner が保存する。送信が終わったときと、画面に戻ってきたとき (自動送信の結果) に読み直す
    var history by remember { mutableStateOf(store.syncHistory()) }
    LaunchedEffect(running) { if (!running) history = store.syncHistory() }
    val progress by AppState.progress.collectAsState()

    val granted = grantedPermissions.containsAll(PermissionPolicy.required(HealthPermissions.all, true))
    val nutritionGranted = PermissionPolicy.canReadNutrition(grantedPermissions)
    val historyGranted = PermissionPolicy.canReadHistory(grantedPermissions)
    val permissionStatus = healthPermissionStatus(HealthPermissions.all, grantedPermissions, historyAvailable)

    fun refreshNotificationState() {
        notificationState = currentNotificationState()
    }

    suspend fun refresh() {
        when (HealthConnectClient.getSdkStatus(context)) {
            HealthConnectClient.SDK_AVAILABLE -> {
                sdkOk = true
                sdkMessage = null
                grantedPermissions = HealthReader(context).grantedPermissions()
                historyAvailable = historyFeatureAvailable(context)
                bgMessage = backgroundReadStatus(context)
            }
            HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> {
                sdkOk = false
                sdkMessage = ScreenMessage("ヘルスコネクトの更新が必要です。Google Play で更新してください", MessageKind.ACTION_NEEDED)
            }
            else -> {
                sdkOk = false
                sdkMessage = ScreenMessage("この端末ではヘルスコネクトを利用できません", MessageKind.WARNING)
            }
        }
        refreshNotificationState()
        // 復号できず消されたトークンを画面にも反映する
        tokenSaved = store.hasToken()
        history = store.syncHistory()
        val requiredGranted = grantedPermissions.containsAll(PermissionPolicy.required(HealthPermissions.all, true))
        if (requiredGranted && tokenSaved) SyncWorker.schedule(context)
    }

    // 昨夜の睡眠が未反映のときの通知に使う。拒否されても送信は今までどおり動く
    val notificationLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { _ ->
        refreshNotificationState()
    }

    fun requestNotificationPermission() {
        store.notificationPermissionRequested = true
        notificationLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    // 「権限を付与」の流れの中で、ヘルスコネクトの権限の後に通知の権限も求める (ADR 0022)
    val launcher = rememberLauncherForActivityResult(HealthPermissions.contract()) { _ ->
        AppState.scope.launch { refresh() }
        refreshNotificationState()
        if (notificationState == NotificationPermissionState.REQUESTABLE) requestNotificationPermission()
    }

    // 設定アプリやヘルスコネクトで権限を変えて戻ってきたときにも反映する
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { scope.launch { refresh() } }

    // 入力内容を検証して保存する。誤りがあれば、その箇所までで止めて誤りの文を返す
    fun saveSettings(): String? {
        val u = url.trim()
        if (!u.startsWith("https://")) return "サーバー URL は https:// で始まる必要があります"
        val t = token.trim()
        if (t.isNotEmpty()) {
            if (!SettingsStore.isValidToken(t)) return "トークンに使えない文字が含まれています"
            store.saveToken(t)
            tokenSaved = true
            token = ""
        }
        val window = SleepCheckWindow.parse(checkStart, checkEnd)
            ?: return "通知の時間帯は 0〜24 の時で、開始を終了より前にしてください"
        store.sleepCheckWindow = window
        store.serverUrl = u
        if (granted && store.hasToken()) SyncWorker.schedule(context)
        return null
    }

    // 保存して、結果を押したボタンの近くに出す。成功したら true。
    // 保存できたら入力欄のフォーカスを外してキーボードを閉じ、保存したことが目に入るようにする
    fun save(fromSend: Boolean): Boolean {
        val error = saveSettings()
        val shown = when {
            error != null && fromSend -> ScreenMessage("$error。送信していません", MessageKind.ERROR)
            error != null -> ScreenMessage(error, MessageKind.ERROR)
            fromSend -> ScreenMessage("設定を保存しました。送信を始めます", MessageKind.SUCCESS)
            else -> ScreenMessage("設定を保存しました", MessageKind.SUCCESS)
        }
        saveMessage = shown.takeUnless { fromSend }
        sendMessage = shown.takeIf { fromSend }
        if (error == null) {
            focusManager.clearFocus()
            keyboard?.hide()
        }
        return error == null
    }


    Column(
        // targetSdk 35 以降は画面の端まで描かれるので、ステータスバー・ナビゲーションバー・キーボードの分を空ける
        Modifier.fillMaxSize().safeDrawingPadding().verticalScroll(rememberScrollState()).padding(16.dp),
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
        Text("睡眠が未反映のときに通知する時間帯 (起床時刻より後に)", style = MaterialTheme.typography.bodyMedium)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = checkStart,
                onValueChange = { checkStart = it },
                label = { Text("開始 (時)") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                modifier = Modifier.weight(1f),
            )
            Text("〜")
            OutlinedTextField(
                value = checkEnd,
                onValueChange = { checkEnd = it },
                label = { Text("終了 (時)") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                modifier = Modifier.weight(1f),
            )
        }
        OutlinedButton(onClick = { save(fromSend = false) }, enabled = !running, modifier = Modifier.fillMaxWidth()) {
            Text("設定を保存")
        }
        saveMessage?.let { MessageText(it) }

        sdkMessage?.let { MessageText(it) }
        if (sdkOk) {
            if (permissionStatus.missingRequired.isEmpty()) {
                Text("ヘルスコネクトの権限: 送信に必要なものは付与済み")
            } else {
                MessageText(
                    ScreenMessage(
                        "ヘルスコネクトの権限が足りません（${permissionStatus.missingRequired.joinToString("、")}）。" +
                            "『権限を付与』で許可してください",
                        MessageKind.ACTION_NEEDED,
                    ),
                )
            }
            if (!nutritionGranted) {
                MessageText(
                    ScreenMessage("栄養の権限がありません。摂取カロリーも送るには『権限を付与』を押してください", MessageKind.ACTION_NEEDED),
                )
            }
        }
        bgMessage?.let { MessageText(it) }

        // ヘルスコネクトの権限のボタン。足りないものがあるときだけ求め、そろったら見直すための控えめなボタンにする
        val requestPermissions = { launcher.launch(requestablePermissions(HealthPermissions.all, historyAvailable)) }
        when {
            !sdkOk -> {}
            permissionStatus.missingRequired.isNotEmpty() -> Button(
                onClick = requestPermissions,
                enabled = !running,
                modifier = Modifier.fillMaxWidth(),
            ) { Text("権限を付与") }
            permissionStatus.missingOptional.isNotEmpty() -> OutlinedButton(
                onClick = requestPermissions,
                enabled = !running,
                modifier = Modifier.fillMaxWidth(),
            ) { Text("権限を付与（任意: ${permissionStatus.missingOptional.joinToString("、")}）") }
            else -> OutlinedButton(
                onClick = {
                    val opened = startActivitySafely(context, HealthConnectClient.getHealthConnectManageDataIntent(context))
                    settingsMessage = if (opened) null else ScreenMessage("ヘルスコネクトの設定を開けませんでした", MessageKind.ERROR)
                },
                modifier = Modifier.fillMaxWidth(),
            ) { Text("ヘルスコネクトの権限を見直す") }
        }

        when (notificationState) {
            NotificationPermissionState.GRANTED -> Text("通知の権限: 付与済み")
            NotificationPermissionState.REQUESTABLE -> {
                MessageText(
                    ScreenMessage("通知の権限がありません。睡眠の未反映や送信の失敗が続いたときに通知が出ません", MessageKind.ACTION_NEEDED),
                )
                OutlinedButton(onClick = { requestNotificationPermission() }, modifier = Modifier.fillMaxWidth()) {
                    Text("通知を許可する")
                }
            }
            NotificationPermissionState.BLOCKED -> {
                MessageText(
                    ScreenMessage(
                        "通知の権限がありません。睡眠の未反映や送信の失敗が続いたときに通知が出ません。" +
                            "許可を求める画面はもう表示されないため、アプリの通知設定で許可してください",
                        MessageKind.ACTION_NEEDED,
                    ),
                )
                OutlinedButton(
                    onClick = {
                        val intent = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                            .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
                        val opened = startActivitySafely(context, intent)
                        settingsMessage = if (opened) null else ScreenMessage("通知の設定を開けませんでした", MessageKind.ERROR)
                    },
                    modifier = Modifier.fillMaxWidth(),
                ) { Text("通知の設定を開く") }
            }
        }
        settingsMessage?.let { MessageText(it) }

        Text("送信のボタンは、入力中の設定を保存してから送ります", style = MaterialTheme.typography.bodyMedium)
        Button(
            onClick = { if (save(fromSend = true)) AppState.start(context, RECENT_SYNC_DAYS) },
            enabled = sdkOk && !running,
            modifier = Modifier.fillMaxWidth(),
        ) { Text("今すぐ送信（直近${RECENT_SYNC_DAYS}日）") }
        Button(
            onClick = { if (save(fromSend = true)) AppState.start(context, BACKFILL_SYNC_DAYS) },
            enabled = sdkOk && !running,
            modifier = Modifier.fillMaxWidth(),
        ) { Text("過去${BACKFILL_SYNC_DAYS}日を送る") }

        val today = LocalDate.now()
        OutlinedButton(
            onClick = { showDatePicker = true },
            enabled = sdkOk && !running,
            modifier = Modifier.fillMaxWidth(),
        ) { Text(startDate?.let { "開始日: $it" } ?: "開始日を選ぶ") }
        Button(
            onClick = { startDate?.let { d -> if (save(fromSend = true)) AppState.start(context, countDays(d, today), d) } },
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
            MessageText(
                ScreenMessage(
                    if (historyAvailable) {
                        "履歴の権限が無いため、${earliestReadableWithoutHistory(today)} より前は読まずに送りません。『権限を付与』で履歴の権限も許可してください"
                    } else {
                        "この端末では履歴の権限を使えないため、${earliestReadableWithoutHistory(today)} より前は読まずに送りません"
                    },
                    MessageKind.WARNING,
                ),
            )
        }
        sendMessage?.let { MessageText(it) }

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
            SyncHistoryText(history)
        }

        OutlinedButton(
            onClick = { context.startActivity(Intent(context, RationaleActivity::class.java)) },
            modifier = Modifier.fillMaxWidth(),
        ) { Text("読み取るデータと送信先について") }
    }
}
