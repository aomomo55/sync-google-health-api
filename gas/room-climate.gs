// 寝室の温湿度計の値を 30 分おきに SwitchBot API から読み、サーバーの POST /room/readings に送る（ADR 0033）。
// サーバーは値を保存するだけで、夜の温湿度は睡眠のデータが届いたときに日次ノートへ書く。
// バックアップ（backup.gs）とは別の GAS プロジェクトに置く（使うトークンごとにプロジェクトを分けるため）。
// 設定と使い方は docs/room-climate.md を参照。
//
// スクリプト プロパティ:
//   SWITCHBOT_TOKEN      SwitchBot アプリで発行したトークン
//   SWITCHBOT_SECRET     SwitchBot アプリで発行したクライアントシークレット
//   SWITCHBOT_DEVICE_ID  温湿度計のデバイス ID（listDevices で調べる）
//   ROOM_URL             サーバーの https://<アプリ>.fly.dev/room/readings
//   ROOM_TOKEN           サーバーの ROOM_TOKEN と同じ値
//   PENDING              （自動で書き込む）送れなかった値。次の実行で一緒に送り直す

const SWITCHBOT_API = "https://api.switch-bot.com/v1.1";
// SwitchBot API の応答の statusCode のうち、成功を表すもの
const SWITCHBOT_SUCCESS = 100;
const INTERVAL_MINUTES = 30;
// 送れなかった値を残す上限（30 分おきで 2 日分）。サーバーが長く止まったときに、プロパティの大きさの上限を超えないため
const MAX_PENDING = 96;
// 手動の実行とトリガーが重なったときに待つ時間
const LOCK_WAIT_MS = 10 * 1000;

// 30 分おきのトリガーから呼ばれる
function recordRoomClimate() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) throw new Error("前の実行が終わっていないので、今回は止めました");
  try {
    const props = PropertiesService.getScriptProperties();
    const reading = readMeter(props);
    // 先に保存してから送る。送信に失敗しても、次の実行で一緒に送り直せる
    const pending = loadPending(props).concat([reading]).slice(-MAX_PENDING);
    props.setProperty("PENDING", JSON.stringify(pending));
    const result = sendReadings(props, pending);
    props.deleteProperty("PENDING");
    console.log(`送信しました: ${pending.length} 件（書き込み ${result.written} / 変更なし ${result.unchanged}）`);
  } finally {
    lock.releaseLock();
  }
}

// 温湿度計の今の値を読む。送らない（動作確認用）
function recordRoomClimateDryRun() {
  const reading = readMeter(PropertiesService.getScriptProperties());
  console.log(JSON.stringify(reading));
}

// SwitchBot のアカウントにあるデバイスの ID・名前・種類を表示する。SWITCHBOT_DEVICE_ID を調べるときに使う
function listDevices() {
  const body = switchbotGet(PropertiesService.getScriptProperties(), "/devices");
  const devices = Array.isArray(body.deviceList) ? body.deviceList : [];
  devices.forEach((d) => {
    console.log(`${d.deviceId}\t${d.deviceName}\t${d.deviceType}`);
  });
}

function readMeter(props) {
  const id = requiredProperty(props, "SWITCHBOT_DEVICE_ID");
  if (!/^[0-9A-Za-z-]+$/.test(id)) throw new Error("SWITCHBOT_DEVICE_ID に使えない文字が含まれています");
  const body = switchbotGet(props, `/devices/${id}/status`);
  const temperature = body.temperature;
  const humidity = body.humidity;
  if (typeof temperature !== "number" || !Number.isFinite(temperature)) {
    throw new Error("SwitchBot API の応答に温度がありません（温湿度計のデバイス ID か確かめてください）");
  }
  if (typeof humidity !== "number" || !Number.isFinite(humidity)) {
    throw new Error("SwitchBot API の応答に湿度がありません（温湿度計のデバイス ID か確かめてください）");
  }
  return {
    time: Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy-MM-dd'T'HH:mm:ssXXX"),
    temperature_c: temperature,
    humidity_pct: humidity,
  };
}

// SwitchBot API v1.1 の GET。署名は token + t + nonce を secret で HMAC-SHA256 し、Base64 にしたもの
function switchbotGet(props, path) {
  const token = requiredProperty(props, "SWITCHBOT_TOKEN");
  const secret = requiredProperty(props, "SWITCHBOT_SECRET");
  const t = String(Date.now());
  const nonce = Utilities.getUuid();
  const sign = Utilities.base64Encode(
    Utilities.computeHmacSha256Signature(token + t + nonce, secret, Utilities.Charset.UTF_8),
  );
  const res = UrlFetchApp.fetch(SWITCHBOT_API + path, {
    headers: { Authorization: token, sign: sign, t: t, nonce: nonce },
    muteHttpExceptions: true,
  });
  const status = res.getResponseCode();
  if (status !== 200) throw new Error(`SwitchBot API が HTTP ${status} を返しました`);
  const json = JSON.parse(res.getContentText());
  if (json.statusCode !== SWITCHBOT_SUCCESS) {
    throw new Error(`SwitchBot API が失敗しました（statusCode ${json.statusCode}: ${json.message}）`);
  }
  return json.body || {};
}

function sendReadings(props, readings) {
  const url = requiredProperty(props, "ROOM_URL");
  // http:// だと最初のリクエストでトークンが平文で流れるので、送る前に止める
  if (!/^https:\/\//i.test(url)) {
    throw new Error(`ROOM_URL は https:// で始めてください。トークンを送らずに止めました（${url}）`);
  }
  const token = requiredProperty(props, "ROOM_TOKEN");
  // fly.io のマシンが止まっていても、このリクエストで起動する
  const res = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: `Bearer ${token}` },
    payload: JSON.stringify({ readings: readings }),
    muteHttpExceptions: true,
    followRedirects: false,
  });
  const status = res.getResponseCode();
  if (status !== 200) {
    throw new Error(`サーバーが HTTP ${status} を返しました（送れなかった ${readings.length} 件は次の実行で送り直します）`);
  }
  return JSON.parse(res.getContentText());
}

function loadPending(props) {
  const raw = props.getProperty("PENDING");
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.warn("PENDING が読めなかったので捨てました");
    return [];
  }
}

function requiredProperty(props, name) {
  const v = props.getProperty(name);
  if (!v) throw new Error(`スクリプト プロパティ ${name} が未設定です`);
  return v;
}

// 最初に一度だけ手動で実行する。30 分おきに recordRoomClimate を実行するトリガーを作る（既存のものは作り直す）
function install() {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === "recordRoomClimate")
    .forEach((t) => {
      ScriptApp.deleteTrigger(t);
    });
  ScriptApp.newTrigger("recordRoomClimate").timeBased().everyMinutes(INTERVAL_MINUTES).create();
}
