package com.syncgooglehealth.app

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager

// 自動送信の失敗が続いていることを知らせる通知 (ADR 0026)
object SyncFailureNotifier {
    private const val CHANNEL_ID = "sync_failure"
    private const val NOTIFICATION_ID = 1002

    // 通知を出したら true。通知の権限が無ければ何もせず false
    fun notify(context: Context, notice: FailureNotice): Boolean {
        if (context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return false
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            // 音を鳴らさない (寝ている間に起こさないため。ADR 0022 と同じ)
            NotificationChannel(
                CHANNEL_ID,
                context.getString(R.string.notification_channel_sync_failure_name),
                NotificationManager.IMPORTANCE_LOW,
            ),
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
            .build()
        manager.notify(NOTIFICATION_ID, notification)
        return true
    }

    fun cancel(context: Context) {
        context.getSystemService(NotificationManager::class.java).cancel(NOTIFICATION_ID)
    }
}
