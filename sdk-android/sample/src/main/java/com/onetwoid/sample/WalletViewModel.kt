package com.onetwoid.sample

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.onetwoid.sdk.Connection
import com.onetwoid.sdk.Credential
import com.onetwoid.sdk.CredentialOffer
import com.onetwoid.sdk.OneTwoId
import com.onetwoid.sdk.OneTwoIdException
import com.onetwoid.sdk.ProofRequest
import com.onetwoid.sdk.ProofRequestOptions
import com.onetwoid.sdk.ProofSelection
import com.onetwoid.sdk.WalletState
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

data class WalletUi(
    val state: WalletState = WalletState.Uninitialized,
    val connections: List<Connection> = emptyList(),
    val credentials: List<Credential> = emptyList(),
    val offers: List<CredentialOffer> = emptyList(),
    val proofRequests: List<ProofRequest> = emptyList(),
    val proofOptions: Map<String, ProofRequestOptions> = emptyMap(),
    val message: String? = null,
)

class WalletViewModel(application: Application) : AndroidViewModel(application) {
    private val _ui = MutableStateFlow(WalletUi())
    val ui: StateFlow<WalletUi> = _ui.asStateFlow()

    init {
        viewModelScope.launch { OneTwoId.state.collect { state -> _ui.value = _ui.value.copy(state = state); if (state is WalletState.Ready) refresh() } }
        viewModelScope.launch { OneTwoId.events.collect { refresh() } }
    }

    fun refresh() = viewModelScope.launch {
        if (OneTwoId.state.value !is WalletState.Ready) return@launch
        runCatching {
            val requests = OneTwoId.pendingProofRequests()
            _ui.value = _ui.value.copy(
                connections = OneTwoId.connections(),
                credentials = OneTwoId.credentials(),
                offers = OneTwoId.pendingOffers(),
                proofRequests = requests,
                proofOptions = requests.associate { it.id to OneTwoId.proofRequestOptions(it.id) },
            )
        }.onFailure { report(it) }
    }

    fun connect(invitationUrl: String) = action("Connecting") { OneTwoId.connect(invitationUrl.trim()); "Connection requested" }
    fun acceptOffer(id: String) = action("Accepting offer") { OneTwoId.acceptOffer(id); "Offer accepted; waiting for the credential" }
    fun declineOffer(id: String) = action("Declining offer") { OneTwoId.declineOffer(id); "Offer declined" }
    fun declineProof(id: String) = action("Declining request") { OneTwoId.declineProofRequest(id); "Request declined" }
    fun respondToProof(id: String, selection: ProofSelection) = action("Sharing proof") { OneTwoId.respondToProofRequest(id, selection); "Proof shared" }
    fun sync() = action("Syncing") { val r = OneTwoId.sync(); "Synced: ${r.offersReceived} offers, ${r.proofRequestsReceived} requests, ${r.credentialsStored} credentials" }
    fun reset() = action("Resetting") {
        OneTwoId.reset()
        (getApplication<Application>() as SampleApp).initializeWallet()
        "Wallet reset; a new wallet was onboarded"
    }
    fun retryInitialize() = action("Retrying") { (getApplication<Application>() as SampleApp).initializeWallet(); null }

    private fun action(label: String, block: suspend () -> String?) = viewModelScope.launch {
        _ui.value = _ui.value.copy(message = "$label…")
        runCatching { block() }
            .onSuccess { _ui.value = _ui.value.copy(message = it); refresh() }
            .onFailure { report(it) }
    }

    private fun report(error: Throwable) {
        val text = when (error) {
            is OneTwoIdException.WalletKeyLost -> "The wallet key is gone (restored on another device?). Reset the wallet."
            is OneTwoIdException -> "${error.javaClass.simpleName}: ${error.message}"
            else -> error.message ?: error.javaClass.simpleName
        }
        _ui.value = _ui.value.copy(message = text)
    }

    fun clearMessage() {
        _ui.value = _ui.value.copy(message = null)
    }
}
