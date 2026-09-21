package com.onetwoid.sample

import android.app.Application
import android.util.Log
import com.onetwoid.sdk.LogLevel
import com.onetwoid.sdk.LogSink
import com.onetwoid.sdk.OneTwoId
import com.onetwoid.sdk.OneTwoIdConfig
import com.onetwoid.sdk.WalletListener
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * What a customer app does with the SDK: configure it once in `Application.onCreate`, hand it a way
 * to get this installation's wallet token, and initialise. Everything else is UI.
 */
class SampleApp : Application() {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    lateinit var backend: CustomerBackend
        private set

    override fun onCreate() {
        super.onCreate()
        backend = CustomerBackend(this, BuildConfig.BACKEND_URL)
        OneTwoId.addListener(WalletListener { event -> Log.i(TAG, "event $event") })
        Captures.register()
        scope.launch { initializeWallet() }
    }

    /** Idempotent; also called from the push path (see SyncWorker) and after reset(). */
    suspend fun initializeWallet() {
        try {
            OneTwoId.initialize(this, config())
            Log.i(TAG, "state=Ready")
        } catch (e: Throwable) {
            Log.e(TAG, "state=Failed ${e.javaClass.simpleName}: ${e.message}", e)
        }
    }

    fun config() = OneTwoIdConfig(
        apiBaseUrl = BuildConfig.PLATFORM_API_URL,
        walletTokenProvider = { backend.walletToken() },
        label = "12id Sample Wallet",
        logSink = LogSink { level, message, error ->
            when (level) {
                LogLevel.Debug -> Log.d(SDK_TAG, message, error)
                LogLevel.Info -> Log.i(SDK_TAG, message, error)
                LogLevel.Warn -> Log.w(SDK_TAG, message, error)
                LogLevel.Error -> Log.e(SDK_TAG, message, error)
            }
        },
    )

    companion object {
        const val TAG = "onetwoid-sample"
        const val SDK_TAG = "onetwoid-sdk"
    }
}
