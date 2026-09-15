package com.onetwoid.sample

import android.content.Context
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.onetwoid.sdk.OneTwoId

/**
 * Collects queued messages after a push. A customer's `FirebaseMessagingService.onMessageReceived`
 * does exactly this when its backend relays `wallet.sync_requested`:
 *
 *     override fun onMessageReceived(message: RemoteMessage) {
 *         if (message.data["type"] == "wallet.sync_requested") SyncWorker.enqueue(applicationContext)
 *     }
 *
 * Expedited work runs right away even in the background; the SDK opens the wallet itself if the
 * process was started by the push.
 */
class SyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val app = applicationContext as SampleApp
        app.initializeWallet()
        return try {
            val result = OneTwoId.sync()
            Log.i(SampleApp.TAG, "sync offers=${result.offersReceived} proofRequests=${result.proofRequestsReceived} stored=${result.credentialsStored} drained=${result.drained}")
            Result.success()
        } catch (e: Exception) {
            Log.e(SampleApp.TAG, "sync failed: ${e.message}", e)
            Result.retry()
        }
    }

    companion object {
        fun enqueue(context: Context) {
            val request = OneTimeWorkRequestBuilder<SyncWorker>()
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork("onetwoid-sync", ExistingWorkPolicy.KEEP, request)
        }
    }
}
