// 健康データ（CouchDB の health DB）のバックアップを、1 日 1 回 Google Drive に保存する。
// サーバーの GET /backup/health が返す age で暗号化済みのファイルを、そのまま置くだけ（ここでは中身を読めない）。
// 設定と使い方は docs/backup.md を参照。
//
// スクリプト プロパティ:
//   BACKUP_URL    サーバーの https://<アプリ>.fly.dev/backup/health
//   BACKUP_TOKEN  サーバーの BACKUP_TOKEN と同じ値
//   FOLDER_ID     保存先の Google Drive のフォルダ ID
//   LAST_DAYS     （自動で書き込む）前回のバックアップの日数

const DAILY_KEEP = 7;
const WEEKLY_KEEP = 5;
const DAILY_PATTERN = /^health-\d{4}-\d{2}-\d{2}\.json\.gz\.age$/;
const WEEKLY_PATTERN = /^health-weekly-\d{4}-\d{2}-\d{2}\.json\.gz\.age$/;

// 毎日のトリガーから呼ばれる
function runBackup() {
  try {
    backup();
  } catch (e) {
    notify("失敗しました", String(e && e.message ? e.message : e));
    throw e;
  }
}

function backup() {
  const props = PropertiesService.getScriptProperties();
  const url = requiredProperty(props, "BACKUP_URL");
  // http:// だと最初のリクエストでトークンが平文で流れる（リダイレクトで https に移る前に送ってしまう）ので、送る前に止める
  if (!/^https:\/\//i.test(url)) {
    throw new Error(`BACKUP_URL は https:// で始めてください。トークンを送らずに止めました（${url}）`);
  }
  const token = requiredProperty(props, "BACKUP_TOKEN");
  const folder = DriveApp.getFolderById(requiredProperty(props, "FOLDER_ID"));

  // fly.io のマシンが止まっていても、このリクエストで起動する
  const res = UrlFetchApp.fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    muteHttpExceptions: true,
    followRedirects: false,
  });
  const status = res.getResponseCode();
  // 応答の本文にはサーバーのエラー文しか入らないが、念のため載せない
  if (status !== 200) throw new Error(`サーバーが HTTP ${status} を返しました（${url}）`);

  const days = Number(header(res, "X-Backup-Days"));
  if (!Number.isInteger(days) || days <= 0) {
    throw new Error(`バックアップの日数が不正です（${header(res, "X-Backup-Days")}）`);
  }

  const date = Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy-MM-dd");
  const blob = res.getBlob();
  saveReplacing(folder, blob, `health-${date}.json.gz.age`);
  // 日曜は週次の世代としても残す
  const isSunday = Utilities.formatDate(new Date(), "Asia/Tokyo", "u") === "7";
  if (isSunday) saveReplacing(folder, blob, `health-weekly-${date}.json.gz.age`);

  const lastDays = Number(props.getProperty("LAST_DAYS") || "0");
  if (days < lastDays) {
    // データが減っている（誤って消したなど）。古い世代を消さずに残し、知らせる
    notify(
      "日数が減っています",
      `前回 ${lastDays} 日分 → 今回 ${days} 日分。古いバックアップは消さずに残しました。` +
        "データが消えていないか確かめ、問題なければスクリプト プロパティの LAST_DAYS を消してください。",
    );
    return;
  }
  props.setProperty("LAST_DAYS", String(days));
  prune(folder, DAILY_PATTERN, DAILY_KEEP);
  prune(folder, WEEKLY_PATTERN, WEEKLY_KEEP);
  console.log(`保存しました: ${days} 日分${isSunday ? "（週次も保存）" : ""}`);
}

// 同じ名前のファイルがあれば（同じ日に手動で実行したときなど）置き換える。
// 作成に失敗してもその日のバックアップが無くならないよう、新しいファイルを作ってから古いものをゴミ箱に移す
function saveReplacing(folder, blob, name) {
  const old = [];
  const existing = folder.getFilesByName(name);
  while (existing.hasNext()) old.push(existing.next());
  folder.createFile(blob.copyBlob().setName(name).setContentType("application/octet-stream"));
  old.forEach((f) => f.setTrashed(true));
}

// 名前（日付入り）の新しい順に keep 個を残し、残りをゴミ箱に移す
function prune(folder, pattern, keep) {
  const files = [];
  const it = folder.getFiles();
  while (it.hasNext()) {
    const f = it.next();
    if (pattern.test(f.getName())) files.push(f);
  }
  files
    .sort((a, b) => (a.getName() < b.getName() ? 1 : a.getName() > b.getName() ? -1 : 0))
    .slice(keep)
    .forEach((f) => {
      f.setTrashed(true);
    });
}

function header(res, name) {
  const headers = res.getAllHeaders();
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : headers[key];
}

function requiredProperty(props, name) {
  const v = props.getProperty(name);
  if (!v) throw new Error(`スクリプト プロパティ ${name} が未設定です`);
  return v;
}

// 自分宛てにメールで知らせる（トークンなどの秘密情報は本文に入れない）
function notify(subject, body) {
  MailApp.sendEmail(
    Session.getEffectiveUser().getEmail(),
    `[健康データのバックアップ] ${subject}`,
    body,
  );
}

// 最初に一度だけ手動で実行する。毎日 4 時台に runBackup を実行するトリガーを作る（既存のものは作り直す）
function install() {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === "runBackup")
    .forEach((t) => {
      ScriptApp.deleteTrigger(t);
    });
  ScriptApp.newTrigger("runBackup").timeBased().everyDays(1).atHour(4).create();
}
