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
import androidx.annotation.StringRes
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
import androidx.compose.ui.res.stringResource
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
private enum class MessageKind(@StringRes val prefix: Int?) {
    INFO(null),
    SUCCESS(null),
    WARNING(R.string.message_prefix_warning),
    ACTION_NEEDED(R.string.message_prefix_action_needed),
    ERROR(R.string.message_prefix_error),
}

// 文言は strings.xml のリソース ID と引数で持ち、表示するときに解決する (画面の設定が変わっても古い文のままにならない)。
// 引数にリソース ID を入れたいときは TextRes で包む
private data class TextRes(@StringRes val id: Int)

private data class ScreenMessage(@StringRes val textRes: Int, val kind: MessageKind, val args: List<Any> = emptyList())

@Composable
private fun MessageText(message: ScreenMessage) {
    val args = message.args.map { if (it is TextRes) stringResource(it.id) else it }
    MessageLine(message.kind, stringResource(message.textRes, *args.toTypedArray()))
}

// 資源にない文 (送信の結果など) をそのまま出すときは、こちらを使う
@Composable
private fun MessageLine(kind: MessageKind, text: String) {
    val color = when (kind) {
        MessageKind.INFO -> Color.Unspecified
        MessageKind.SUCCESS -> MaterialTheme.colorScheme.primary
        MessageKind.WARNING, MessageKind.ACTION_NEEDED, MessageKind.ERROR -> MaterialTheme.colorScheme.error
    }
    Text((kind.prefix?.let { stringResource(it) } ?: "") + text, color = color)
}

// 「最後に成功」と「最後に試した」を分けて出す。失敗が続いても時刻だけ新しく見えないようにするため (ADR 0026)
@Composable
private fun SyncHistoryText(history: SyncHistory) {
    val success = history.lastSuccessMillis
    val attempt = history.lastAttemptMillis
    val context = LocalContext.current
    if (success == null && attempt == null) {
        Text(stringResource(R.string.sync_history_never))
        return
    }
    val successText = success?.let { SyncRunner.formatTime(context, it) } ?: stringResource(R.string.sync_history_no_record)
    Text(stringResource(R.string.sync_history_last_success, successText))
    if (attempt != null && attempt != success) {
        val failedSuffix = when {
            history.lastFailed -> stringResource(R.string.sync_history_failed_suffix)
            history.lastNotesFailed -> stringResource(R.string.sync_history_notes_failed_suffix)
            else -> ""
        }
        Text(stringResource(R.string.sync_history_last_attempt, SyncRunner.formatTime(context, attempt), failedSuffix))
    }
    history.lastResult?.let { result ->
        if (history.lastFailed) MessageLine(MessageKind.ERROR, result) else Text(stringResource(R.string.sync_history_result, result))
    }
    history.lastWarning?.split(WARNING_LINE_SEPARATOR)?.forEach { MessageLine(MessageKind.WARNING, it) }
    if (isSuccessStale(System.currentTimeMillis(), success)) {
        MessageText(ScreenMessage(R.string.sync_history_stale, MessageKind.WARNING, listOf(STALE_SUCCESS_WARNING_HOURS)))
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
            ScreenMessage(R.string.health_connect_background_available, MessageKind.INFO)
        } else {
            ScreenMessage(R.string.health_connect_background_unavailable, MessageKind.WARNING)
        }
    } catch (e: Exception) {
        ScreenMessage(R.string.health_connect_background_unknown, MessageKind.WARNING)
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
    val texts = remember(context) { ContextTexts(context) }
    val listSeparator = stringResource(R.string.common_list_separator)
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
    val permissionStatus = healthPermissionStatus(texts, HealthPermissions.all, grantedPermissions, historyAvailable)

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
                sdkMessage = ScreenMessage(R.string.health_connect_update_required, MessageKind.ACTION_NEEDED)
            }
            else -> {
                sdkOk = false
                sdkMessage = ScreenMessage(R.string.health_connect_unavailable, MessageKind.WARNING)
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

    // 入力をすべて検証し、誤りが無いときだけまとめて保存する。誤りがあれば何も保存せずに誤りの文を返す
    fun saveSettings(): Int? {
        val settings = when (val result = validateSettings(SettingsInput(url, token, checkStart, checkEnd))) {
            is SettingsValidation.Invalid -> return result.error
            is SettingsValidation.Valid -> result.settings
        }
        settings.token?.let {
            store.saveToken(it)
            tokenSaved = true
            token = ""
        }
        store.sleepCheckWindow = settings.sleepCheckWindow
        store.serverUrl = settings.serverUrl
        if (granted && store.hasToken()) SyncWorker.schedule(context)
        return null
    }

    // 保存して、結果を押したボタンの近くに出す。成功したら true。
    // 保存できたら入力欄のフォーカスを外してキーボードを閉じ、保存したことが目に入るようにする
    fun save(fromSend: Boolean): Boolean {
        val error = saveSettings()
        val shown = when {
            error != null && fromSend -> ScreenMessage(R.string.settings_error_not_sent, MessageKind.ERROR, listOf(TextRes(error)))
            error != null -> ScreenMessage(error, MessageKind.ERROR)
            fromSend -> ScreenMessage(R.string.settings_saved_and_sending, MessageKind.SUCCESS)
            else -> ScreenMessage(R.string.settings_saved, MessageKind.SUCCESS)
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
        Text(stringResource(R.string.app_name), style = MaterialTheme.typography.headlineSmall)

        OutlinedTextField(
            value = url,
            onValueChange = { url = it },
            label = { Text(stringResource(R.string.settings_server_url_label)) },
            placeholder = { Text(stringResource(R.string.settings_server_url_placeholder)) },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = token,
            onValueChange = { token = it },
            label = { Text(stringResource(R.string.settings_token_label)) },
            placeholder = { if (tokenSaved) Text(stringResource(R.string.settings_token_saved_placeholder)) },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
            modifier = Modifier.fillMaxWidth(),
        )
        Text(stringResource(R.string.settings_sleep_window_title), style = MaterialTheme.typography.bodyMedium)
        Text(
            stringResource(R.string.settings_sleep_window_hint),
            style = MaterialTheme.typography.bodyMedium,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = checkStart,
                onValueChange = { checkStart = it },
                label = { Text(stringResource(R.string.settings_sleep_window_start_label)) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                modifier = Modifier.weight(1f),
            )
            Text(stringResource(R.string.settings_sleep_window_separator))
            OutlinedTextField(
                value = checkEnd,
                onValueChange = { checkEnd = it },
                label = { Text(stringResource(R.string.settings_sleep_window_end_label)) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                modifier = Modifier.weight(1f),
            )
        }
        OutlinedButton(onClick = { save(fromSend = false) }, enabled = !running, modifier = Modifier.fillMaxWidth()) {
            Text(stringResource(R.string.settings_save_button))
        }
        saveMessage?.let { MessageText(it) }

        sdkMessage?.let { MessageText(it) }
        if (sdkOk) {
            if (permissionStatus.missingRequired.isEmpty()) {
                Text(stringResource(R.string.permission_health_granted))
            } else {
                MessageText(
                    ScreenMessage(
                        R.string.permission_health_missing,
                        MessageKind.ACTION_NEEDED,
                        listOf(permissionStatus.missingRequired.joinToString(listSeparator)),
                    ),
                )
            }
            if (!nutritionGranted) {
                MessageText(
                    ScreenMessage(R.string.permission_nutrition_missing, MessageKind.ACTION_NEEDED),
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
            ) { Text(stringResource(R.string.permission_grant_button)) }
            permissionStatus.missingOptional.isNotEmpty() -> OutlinedButton(
                onClick = requestPermissions,
                enabled = !running,
                modifier = Modifier.fillMaxWidth(),
            ) { Text(stringResource(R.string.permission_grant_optional_button, permissionStatus.missingOptional.joinToString(listSeparator))) }
            else -> OutlinedButton(
                onClick = {
                    val opened = startActivitySafely(context, HealthConnectClient.getHealthConnectManageDataIntent(context))
                    settingsMessage = if (opened) null else ScreenMessage(R.string.permission_health_settings_open_failed, MessageKind.ERROR)
                },
                modifier = Modifier.fillMaxWidth(),
            ) { Text(stringResource(R.string.permission_review_button)) }
        }

        when (notificationState) {
            NotificationPermissionState.GRANTED -> Text(stringResource(R.string.permission_notification_granted))
            NotificationPermissionState.REQUESTABLE -> {
                MessageText(
                    ScreenMessage(R.string.permission_notification_missing, MessageKind.ACTION_NEEDED),
                )
                OutlinedButton(onClick = { requestNotificationPermission() }, modifier = Modifier.fillMaxWidth()) {
                    Text(stringResource(R.string.permission_notification_allow_button))
                }
            }
            NotificationPermissionState.BLOCKED -> {
                MessageText(
                    ScreenMessage(R.string.permission_notification_blocked, MessageKind.ACTION_NEEDED),
                )
                OutlinedButton(
                    onClick = {
                        val intent = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                            .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
                        val opened = startActivitySafely(context, intent)
                        settingsMessage = if (opened) null else ScreenMessage(R.string.permission_notification_settings_open_failed, MessageKind.ERROR)
                    },
                    modifier = Modifier.fillMaxWidth(),
                ) { Text(stringResource(R.string.permission_notification_settings_button)) }
            }
        }
        settingsMessage?.let { MessageText(it) }

        Text(stringResource(R.string.sync_buttons_hint), style = MaterialTheme.typography.bodyMedium)
        Button(
            onClick = { if (save(fromSend = true)) AppState.start(context, RECENT_SYNC_DAYS) },
            enabled = sdkOk && !running,
            modifier = Modifier.fillMaxWidth(),
        ) { Text(stringResource(R.string.sync_recent_button, RECENT_SYNC_DAYS)) }
        Button(
            onClick = { if (save(fromSend = true)) AppState.start(context, BACKFILL_SYNC_DAYS) },
            enabled = sdkOk && !running,
            modifier = Modifier.fillMaxWidth(),
        ) { Text(stringResource(R.string.sync_backfill_button, BACKFILL_SYNC_DAYS)) }

        val today = LocalDate.now(CALENDAR_ZONE)
        OutlinedButton(
            onClick = { showDatePicker = true },
            enabled = sdkOk && !running,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(startDate?.let { stringResource(R.string.sync_start_date_selected_button, it) } ?: stringResource(R.string.sync_start_date_pick_button))
        }
        Button(
            onClick = { startDate?.let { d -> if (save(fromSend = true)) AppState.start(context, countDays(d, today), d) } },
            enabled = sdkOk && !running && startDate != null,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(startDate?.let { stringResource(R.string.sync_from_start_date_button, it) } ?: stringResource(R.string.sync_from_start_date_unselected_button))
        }
        Text(
            stringResource(R.string.sync_start_date_hint, MAX_START_DAYS_BACK, earliestSelectableStart(today)),
            style = MaterialTheme.typography.bodySmall,
        )
        val selected = startDate
        if (sdkOk && selected != null && needsHistoryPermission(selected, today) && !historyGranted) {
            MessageText(
                ScreenMessage(
                    if (historyAvailable) R.string.permission_history_missing else R.string.permission_history_unavailable,
                    MessageKind.WARNING,
                    listOf(earliestReadableWithoutHistory(today)),
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
                    }) { Text(stringResource(R.string.sync_date_picker_confirm)) }
                },
                dismissButton = { TextButton(onClick = { showDatePicker = false }) { Text(stringResource(R.string.common_cancel)) } },
            ) { DatePicker(state = pickerState) }
        }

        // 送信中に前回の結果（古いエラーなど）が見えると紛らわしいので隠す
        if (running) {
            Text(progress ?: stringResource(R.string.sync_running))
        } else {
            SyncHistoryText(history)
        }

        OutlinedButton(
            onClick = { context.startActivity(Intent(context, RationaleActivity::class.java)) },
            modifier = Modifier.fillMaxWidth(),
        ) { Text(stringResource(R.string.sync_rationale_button)) }
    }
}
