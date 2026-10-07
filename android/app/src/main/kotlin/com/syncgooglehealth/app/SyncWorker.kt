package com.syncgooglehealth.app

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

class SyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val outcome = SyncRunner.run(applicationContext, days = RECENT_SYNC_DAYS, requireBackground = true)
        return when (outcome.status) {
            SyncStatus.OK -> Result.success()
            SyncStatus.RETRYABLE -> Result.retry()
            // 認証エラーや設定・権限の問題は再試行しても直らない
            SyncStatus.AUTH_ERROR, SyncStatus.FAILED -> Result.failure()
        }
    }

    companion object {
        private const val UNIQUE_NAME = "periodic_sync"
        // 定期送信の間隔。権限の説明画面 (RationaleActivity) の文言にも使う
        const val INTERVAL_HOURS = 6L
        private const val BACKOFF_MINUTES = 15L

        fun schedule(context: Context) {
            val request = PeriodicWorkRequestBuilder<SyncWorker>(INTERVAL_HOURS, TimeUnit.HOURS)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, BACKOFF_MINUTES, TimeUnit.MINUTES)
                .build()
            WorkManager.getInstance(context)
                .enqueueUniquePeriodicWork(UNIQUE_NAME, ExistingPeriodicWorkPolicy.UPDATE, request)
        }
    }
}
