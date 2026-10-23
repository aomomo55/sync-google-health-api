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

    fun notify(context: Context) {
        // 通知の権限が無ければ何もしない (送信自体は成功しているので失敗にはしない)
        if (context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "睡眠データの未反映", NotificationManager.IMPORTANCE_DEFAULT),
        )
        val open = PendingIntent.getActivity(
            context,
            0,
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notification = Notification.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("昨夜の睡眠がまだ届いていません")
            .setContentText("ウェアラブルのアプリを開いて同期してください")
            .setStyle(
                Notification.BigTextStyle().bigText(
                    "ウェアラブルのアプリを開いて同期してください。次の自動送信か「今すぐ送信」で取り込みます",
                ),
            )
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()
        manager.notify(NOTIFICATION_ID, notification)
    }

    fun cancel(context: Context) {
        context.getSystemService(NotificationManager::class.java).cancel(NOTIFICATION_ID)
    }
}
