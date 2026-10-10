package com.onetwoid.reference

import android.content.Context
import android.util.Log
import com.onetwoid.sdk.Credential
import com.onetwoid.sdk.CredentialOffer
import com.onetwoid.sdk.LogLevel
import com.onetwoid.sdk.LogSink
import com.onetwoid.sdk.OneTwoId
import com.onetwoid.sdk.OneTwoIdConfig
import com.onetwoid.sdk.ProofRequest
import com.onetwoid.sdk.WalletEvent
import kotlinx.coroutines.flow.SharedFlow
import kotlin.time.Duration.Companion.seconds

/**
 * Every use of the 12id SDK in this app. The wallet lives on this phone: its keys and credentials
 * never leave it. Each function below is one SDK call or two; the SDK guide explains them
 * (https://docs.12id.com, "Android SDK").
 */
class Wallet(private val context: Context, private val backend: Backend) {
    private var tokenAsked = false

    /** Offers, proof requests and results arrive here. */
    val events: SharedFlow<WalletEvent> get() = OneTwoId.events

    /**
     * Opens the wallet; on the first launch it is created and registered with 12id, which takes a few
     * seconds. Safe to call again. The SDK asks for the wallet token when it needs one, and asks a
     * second time only when 12id rejected the first.
     */
    suspend fun open() {
        OneTwoId.initialize(
            context,
            OneTwoIdConfig(
                apiBaseUrl = BuildConfig.PLATFORM_API_URL,
                walletTokenProvider = { backend.walletToken(refresh = tokenAsked).also { tokenAsked = true } },
                label = "Reference app",
                logSink = LogSink { level, message, error ->
                    when (level) {
                        LogLevel.Debug -> Log.d(TAG, message, error)
                        LogLevel.Info -> Log.i(TAG, message, error)
                        LogLevel.Warn -> Log.w(TAG, message, error)
                        LogLevel.Error -> Log.e(TAG, message, error)
                    }
                },
            ),
        )
    }

    /** Accepts the organisation's invitation, then tells the wallet that its credential offer is on the way. */
    suspend fun connect(invitationUrl: String) {
        OneTwoId.connect(invitationUrl)
        expect(60)
    }

    /**
     * Call this at the moment the app asks its backend for something that makes 12id send a message
     * (an offer, a proof request). The wallet then collects it within a second or two. Without it the
     * message waits for a push or for the app to come to the foreground: the wallet does not poll.
     */
    fun expect(seconds: Int = 30) = OneTwoId.expectMessages(seconds.seconds)

    suspend fun card(): Credential? = OneTwoId.credentials().firstOrNull()

    suspend fun pendingOffer(): CredentialOffer? = OneTwoId.pendingOffers().firstOrNull()

    /** The credential is stored by the SDK when it arrives; WalletEvent.CredentialStored follows. */
    suspend fun accept(offer: CredentialOffer) = OneTwoId.acceptOffer(offer.id)

    suspend fun decline(offer: CredentialOffer) = OneTwoId.declineOffer(offer.id)

    suspend fun pendingRequest(): ProofRequest? = OneTwoId.pendingProofRequests().firstOrNull()

    /**
     * Answers a proof request with the stored credential that matches it. The wallet builds the proof on
     * the phone and reveals only the attributes the request names. Returns false when no credential fits.
     */
    suspend fun approve(request: ProofRequest): Boolean {
        val selection = OneTwoId.proofRequestOptions(request.id).defaultSelection() ?: return false
        OneTwoId.respondToProofRequest(request.id, selection)
        return true
    }

    suspend fun decline(request: ProofRequest) = OneTwoId.declineProofRequest(request.id)

    /** Deletes the wallet and its key. The credentials are gone; the organisation issues them again. */
    suspend fun reset() {
        OneTwoId.reset()
        tokenAsked = false
    }

    private companion object {
        const val TAG = "12id-sdk"
    }
}
