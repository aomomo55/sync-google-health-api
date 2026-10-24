package com.syncgooglehealth.app

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager

// 昨夜の睡眠がまだ届いていないことを知らせる通知。
// 特定のメーカーのアプリには依存させず、「ウェアラブルのアプリ」とだけ書く
object MissingSleepNotifier {
    private const val CHANNEL_ID = "missing_sleep"
    private const val NOTIFICATION_ID = 1001

    // 通知を出したら true。通知の権限が無ければ何もせず false (送信自体は成功しているので失敗にはしない)
    fun notify(context: Context, notice: MissingSleepNotice): Boolean {
        if (context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return false
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            // 音を鳴らさない (まだ寝ている時刻に起こさないため)
            NotificationChannel(CHANNEL_ID, "睡眠データの未反映", NotificationManager.IMPORTANCE_LOW),
        )
        val open = PendingIntent.getActivity(
            context,
            0,
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notification = Notification.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(notice.title)
            .setContentText(notice.text)
            .setStyle(Notification.BigTextStyle().bigText(notice.detail))
            .setContentIntent(open)
            .setAutoCancel(true)
            // 確かめ直して出し直すときに、知らせ直さない (内容と時刻だけを新しくする)
            .setOnlyAlertOnce(true)
            .build()
        manager.notify(NOTIFICATION_ID, notification)
        return true
    }

    // 通知が今も出ているか。今日出した通知が消えていれば、利用者が消した (またはタップした) とみなす
    fun isShowing(context: Context): Boolean =
        context.getSystemService(NotificationManager::class.java).activeNotifications.any { it.id == NOTIFICATION_ID }

    fun cancel(context: Context) {
        context.getSystemService(NotificationManager::class.java).cancel(NOTIFICATION_ID)
    }
}
