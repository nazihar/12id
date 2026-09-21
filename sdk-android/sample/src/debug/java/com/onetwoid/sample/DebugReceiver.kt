package com.onetwoid.sample

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.onetwoid.sdk.OneTwoId
import com.onetwoid.sdk.WalletState
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Debug-only entry points for `smoke:sdk-android`, driven with
 * `adb shell am broadcast -a com.onetwoid.sample.<ACTION> [--es url <invitation>]`.
 * Every action logs one `dump {json}` line the smoke reads from logcat.
 */
class DebugReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val app = context.applicationContext as SampleApp
        val pending = goAsync()
        app.scope.launch {
            try {
                when (intent.action?.substringAfterLast('.')) {
                    "SIMULATE_PUSH" -> SyncWorker.enqueue(context)
                    "CONNECT" -> OneTwoId.connect(requireNotNull(intent.getStringExtra("url")) { "missing --es url" })
                    "ACCEPT_OFFERS" -> OneTwoId.pendingOffers().forEach { OneTwoId.acceptOffer(it.id) }
                    "DECLINE_OFFERS" -> OneTwoId.pendingOffers().forEach { OneTwoId.declineOffer(it.id) }
                    "RESPOND_PROOFS" -> OneTwoId.pendingProofRequests().forEach { request ->
                        val selection = OneTwoId.proofRequestOptions(request.id).defaultSelection()
                        if (selection != null) OneTwoId.respondToProofRequest(request.id, selection) else Log.w(SampleApp.TAG, "no selection for ${request.id}")
                    }
                    "DECLINE_PROOFS" -> OneTwoId.pendingProofRequests().forEach { OneTwoId.declineProofRequest(it.id) }
                    "WIPE_WALLET_KEEP_STATE" -> wipeWalletKeepState(context)
                    // Phase 6: preset the mock capture (same|other|none|not-live) and run every pending face check.
                    // Needs MainActivity in the foreground (am start first): a capture shows UI.
                    "VERIFY_FACES" -> {
                        Captures.mockPreset = intent.getStringExtra("preset")
                        SampleCommands.verifyAll.emit(Unit)
                    }
                    "DUMP" -> Unit
                }
                Log.i(SampleApp.TAG, "dump ${dump()}")
            } catch (e: Exception) {
                Log.e(SampleApp.TAG, "dump {\"error\":\"${e.javaClass.simpleName}: ${e.message}\"}", e)
            } finally {
                pending.finish()
            }
        }
    }

    private suspend fun dump(): JSONObject {
        val state = OneTwoId.state.value
        val json = JSONObject().put("state", state.javaClass.simpleName)
        if (state is WalletState.Failed) json.put("error", "${state.error.javaClass.simpleName}: ${state.error.message}")
        if (state !is WalletState.Ready) return json
        return json
            .put("connections", JSONArray(OneTwoId.connections().map { JSONObject().put("id", it.id).put("label", it.label).put("status", it.status.name) }))
            .put("credentials", JSONArray(OneTwoId.credentials().map { JSONObject().put("id", it.id).put("credentialDefinitionId", it.credentialDefinitionId).put("attributes", JSONObject(it.attributes)) }))
            .put("offers", JSONArray(OneTwoId.pendingOffers().map { JSONObject().put("id", it.id).put("attributes", JSONObject(it.attributes)).put("biometric", it.biometric?.let { b -> JSONObject().put("status", b.status.name).put("attemptsRemaining", b.attemptsRemaining).put("provider", b.provider) }) }))
            .put("proofRequests", JSONArray(OneTwoId.pendingProofRequests().map { JSONObject().put("id", it.id).put("name", it.name).put("biometric", it.biometric?.let { b -> JSONObject().put("status", b.status.name).put("attemptsRemaining", b.attemptsRemaining).put("provider", b.provider) }) }))
    }

    /**
     * Reproduces "the user's wallet data is gone but the SDK state survived" (Phase 3 trap 31): the
     * framework's store and preferences are deleted, the SDK's persisted (spent) invitation is kept.
     * The next initialize must time out on the mediator and recover with a fresh invitation.
     */
    private fun wipeWalletKeepState(context: Context) {
        File(context.filesDir, "wallet").deleteRecursively()
        context.getSharedPreferences("aries-framework-kotlin", Context.MODE_PRIVATE).edit().clear().commit()
        Log.i(SampleApp.TAG, "wallet wiped; SDK state kept. Force-stop and relaunch to reproduce the spent-invitation path")
    }
}
