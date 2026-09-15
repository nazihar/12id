package com.onetwoid.sdk

import android.content.Context
import android.util.Base64
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import com.onetwoid.sdk.internal.GenesisCache
import com.onetwoid.sdk.internal.KeystoreKeyWrapper
import com.onetwoid.sdk.internal.Mappers
import com.onetwoid.sdk.internal.MediatorInvitationPolicy
import com.onetwoid.sdk.internal.PlatformClient
import com.onetwoid.sdk.internal.SdkLog
import com.onetwoid.sdk.internal.SdkStore
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.filterIsInstance
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import org.hyperledger.ariesframework.agent.Agent
import org.hyperledger.ariesframework.agent.AgentConfig
import org.hyperledger.ariesframework.agent.AgentEvents
import org.hyperledger.ariesframework.agent.MediatorPickupStrategy
import org.hyperledger.ariesframework.agent.MessageSerializer
import org.hyperledger.ariesframework.connection.models.ConnectionState
import org.hyperledger.ariesframework.credentials.models.AcceptOfferOptions
import org.hyperledger.ariesframework.credentials.models.AutoAcceptCredential
import org.hyperledger.ariesframework.credentials.models.CredentialState
import org.hyperledger.ariesframework.credentials.repository.CredentialExchangeRecord
import org.hyperledger.ariesframework.oob.models.HandshakeProtocol
import org.hyperledger.ariesframework.oob.models.ReceiveOutOfBandInvitationConfig
import org.hyperledger.ariesframework.proofs.messages.RequestPresentationMessage
import org.hyperledger.ariesframework.proofs.models.AutoAcceptProof
import org.hyperledger.ariesframework.proofs.models.ProofState
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds
import org.hyperledger.ariesframework.proofs.models.ProofRequest as IndyProofRequest

/**
 * The 12id holder wallet. Call [initialize] from `Application.onCreate` (it is idempotent), then use the
 * other functions. All functions are safe to call from any thread and switch to a background dispatcher.
 */
public object OneTwoId {
    private const val WALLET_ID = "onetwoid"
    private const val STATE_DIRECTORY = "onetwoid"

    private val initMutex = Mutex()
    private val _state = MutableStateFlow<WalletState>(WalletState.Uninitialized)
    private val _events = MutableSharedFlow<WalletEvent>(extraBufferCapacity = 64)
    private val listeners = CopyOnWriteArrayList<WalletListener>()

    @Volatile private var session: Session? = null

    @Volatile private var lastInit: Pair<Context, OneTwoIdConfig>? = null

    /** Current wallet state. */
    public val state: StateFlow<WalletState> = _state.asStateFlow()

    /** Wallet events, emitted on a background thread. */
    public val events: SharedFlow<WalletEvent> = _events.asSharedFlow()

    /** Registers a listener, called on a background thread. */
    public fun addListener(listener: WalletListener) {
        listeners += listener
    }

    public fun removeListener(listener: WalletListener) {
        listeners -= listener
    }

    /**
     * Opens the wallet: on first launch creates it, fetches the ledger genesis and connects to the
     * mediator through this installation's single-use invitation. Later launches reuse all of that.
     */
    public suspend fun initialize(context: Context, config: OneTwoIdConfig) {
        val appContext = context.applicationContext ?: context
        lastInit = appContext to config
        SdkLog.sink = config.logSink
        initMutex.withLock {
            if (session != null) return
            _state.value = WalletState.Initializing
            try {
                session = withContext(Dispatchers.IO) { openSession(appContext, config) }
                _state.value = WalletState.Ready
            } catch (e: CancellationException) {
                _state.value = WalletState.Uninitialized
                throw e
            } catch (e: OneTwoIdException) {
                _state.value = WalletState.Failed(e)
                throw e
            } catch (e: UnsatisfiedLinkError) {
                // The native libraries could not be loaded on this device (unsupported ABI or Android version).
                val wrapped = OneTwoIdException.Internal("native libraries failed to load: ${e.message}", e)
                _state.value = WalletState.Failed(wrapped)
                throw wrapped
            } catch (e: Throwable) {
                val wrapped = OneTwoIdException.Internal("initialize failed: ${e.message}", e)
                _state.value = WalletState.Failed(wrapped)
                throw wrapped
            }
        }
    }

    /** Accepts an organisation's connection invitation (the `?oob=` / `?c_i=` URL or its QR payload). */
    public suspend fun connect(invitationUrl: String): Connection = withSession { s ->
        try {
            s.agent.oob.parseInvitationShortUrl(invitationUrl)
        } catch (e: Exception) {
            throw OneTwoIdException.InvalidInvitation(e)
        }
        val (_, record) = s.agent.oob.receiveInvitationFromUrl(
            invitationUrl,
            // Pass the label explicitly: an absent one is sent as no label at all.
            ReceiveOutOfBandInvitationConfig(label = s.label, autoAcceptConnection = true),
        )
        record?.let(Mappers::connection) ?: throw OneTwoIdException.InvalidInvitation()
    }

    /** Connections with organisations (the mediator connection is not listed). */
    public suspend fun connections(): List<Connection> = withSession { s ->
        s.agent.connectionRepository.getAll().filter { it.mediatorId != null }.map(Mappers::connection)
    }

    public suspend fun credentials(): List<Credential> = withSession { s ->
        s.agent.credentialRepository.getAll().map(Mappers::credential)
    }

    public suspend fun credential(id: String): Credential? = withSession { s ->
        s.agent.credentialRepository.findSingleByQuery(tagQuery("credentialId", id))?.let(Mappers::credential)
    }

    public suspend fun pendingOffers(): List<CredentialOffer> = withSession { s ->
        s.agent.credentialExchangeRepository.findByQuery(tagQuery("state", CredentialState.OfferReceived.name))
            .filter { it.protocolVersion == "v1" }
            .map { offer(s, it) }
    }

    /** Requests the credential; it is stored when the organisation issues it ([WalletEvent.CredentialStored]). */
    public suspend fun acceptOffer(id: String): Unit = withSession { s ->
        requireOffer(s, id)
        // The per-record Always makes the framework store and acknowledge the credential when it arrives.
        s.agent.credentials.acceptOffer(AcceptOfferOptions(credentialRecordId = id, autoAcceptCredential = AutoAcceptCredential.Always))
        Unit
    }

    public suspend fun declineOffer(id: String): Unit = withSession { s ->
        requireOffer(s, id)
        s.agent.credentials.declineOffer(AcceptOfferOptions(credentialRecordId = id))
        Unit
    }

    public suspend fun pendingProofRequests(): List<ProofRequest> = withSession { s ->
        s.agent.proofRepository.findByQuery(tagQuery("state", ProofState.RequestReceived.name)).map { record ->
            Mappers.proofRequest(
                id = record.id,
                connectionId = record.connectionId,
                connectionLabel = connectionLabel(s, record.connectionId),
                receivedAtEpochSeconds = record.createdAt.epochSeconds,
                request = indyProofRequest(s, record.id),
            )
        }
    }

    /** The stored credentials that can answer each group of the request. */
    public suspend fun proofRequestOptions(id: String): ProofRequestOptions = withSession { s ->
        requireProofRequest(s, id)
        Mappers.proofRequestOptions(id, s.agent.proofs.getRequestedCredentialsForProofRequest(id))
    }

    /** Sends a proof built from the chosen credentials. */
    public suspend fun respondToProofRequest(id: String, selection: ProofSelection): Unit = withSession { s ->
        requireProofRequest(s, id)
        val requested = Mappers.requestedCredentials(s.agent.proofs.getRequestedCredentialsForProofRequest(id), selection)
        s.agent.proofs.acceptRequest(id, requested)
        Unit
    }

    public suspend fun declineProofRequest(id: String): Unit = withSession { s ->
        requireProofRequest(s, id)
        s.agent.proofs.declineRequest(id)
        Unit
    }

    /**
     * Collects messages queued at the mediator now. Call it from your push handler when your backend
     * receives `wallet.sync_requested`. Opens the wallet first if this process has not done so, using the
     * configuration of the last [initialize] call.
     */
    public suspend fun sync(timeout: Duration = 20.seconds): SyncResult {
        val s = session ?: lastInit?.let { (context, config) ->
            initialize(context, config)
            session
        } ?: throw OneTwoIdException.NotInitialized()

        val offersBefore = s.offersReceived.get()
        val requestsBefore = s.proofRequestsReceived.get()
        val storedBefore = s.credentialsStored.get()
        val drained = withContext(Dispatchers.IO) {
            withTimeoutOrNull(timeout) {
                while (true) {
                    // Subscribe before asking, or a fast batch reply is missed (the bus has no replay).
                    val nextBatch = async(start = CoroutineStart.UNDISPATCHED) {
                        s.agent.eventBus.events.filterIsInstance<AgentEvents.PickupEvent>().first()
                    }
                    s.agent.mediationRecipient.pickupMessages()
                    if (nextBatch.await().messageCount == 0) break
                }
                true
            } ?: false
        }
        return SyncResult(
            offersReceived = s.offersReceived.get() - offersBefore,
            proofRequestsReceived = s.proofRequestsReceived.get() - requestsBefore,
            credentialsStored = s.credentialsStored.get() - storedBefore,
            drained = drained,
        )
    }

    /**
     * Deletes the wallet, its key and all SDK state (4-init §12.2: a lost wallet is not recovered;
     * organisations re-issue). The next [initialize] onboards a new wallet.
     */
    public suspend fun reset() {
        initMutex.withLock {
            withContext(Dispatchers.IO) {
                val current = session
                session = null
                val context = current?.context ?: lastInit?.first
                if (current != null) {
                    close(current)
                    runCatching { current.agent.wallet.delete() }
                } else if (context != null) {
                    // No open session (e.g. WalletKeyLost): delete the store without its key.
                    val label = runCatching { stateStore(context).read().label }.getOrNull() ?: lastInit?.second?.label
                    if (label != null) {
                        runCatching { Agent(context, AgentConfig(walletKey = "", genesisPath = "", walletId = WALLET_ID, label = label)).wallet.delete() }
                    }
                }
                context?.let { stateStore(it).clear() }
                runCatching { KeystoreKeyWrapper().deleteKey() }
                _state.value = WalletState.Uninitialized
            }
        }
    }

    // --- opening ---------------------------------------------------------------------------------

    private suspend fun openSession(context: Context, config: OneTwoIdConfig): Session {
        val store = stateStore(context)
        val keyWrapper = KeystoreKeyWrapper()
        val platform = PlatformClient(config.apiBaseUrl, config.walletTokenProvider)
        var state = store.read()

        // The framework keys the wallet's storage by label, so the onboarding label is kept for good.
        val label = state.label ?: config.label
        val newWallet = state.wrappedWalletKey == null
        val walletKey = if (newWallet) {
            val key = Agent.generateWalletKey()
            val wrapped = Base64.encodeToString(keyWrapper.wrap(key.toByteArray()), Base64.NO_WRAP)
            state = store.update { it.copy(wrappedWalletKey = wrapped, label = label, mediatorInvitationUrl = null) }
            key
        } else {
            try {
                String(keyWrapper.unwrap(Base64.decode(state.wrappedWalletKey, Base64.NO_WRAP)))
            } catch (e: Exception) {
                throw OneTwoIdException.WalletKeyLost(e)
            }
        }

        val genesis = GenesisCache(File(store.directory, "genesis"), platform).resolve(state.genesisSha256)
        if (genesis.sha256 != state.genesisSha256) {
            state = store.update { it.copy(genesisSha256 = genesis.sha256) }
        }

        var invitation = when (val start = MediatorInvitationPolicy.start(state.mediatorInvitationUrl)) {
            is MediatorInvitationPolicy.Start.UsePersisted -> start.invitationUrl
            MediatorInvitationPolicy.Start.FetchNew -> fetchInvitation(platform, store)
        }
        var retried = false
        var removeLeftovers = newWallet
        while (true) {
            val agent = Agent(context, agentConfig(walletKey, genesis.file.absolutePath, invitation, label))
            if (removeLeftovers) {
                // A store from an earlier installation of the SDK state would refuse the new key.
                runCatching { agent.wallet.delete() }
                removeLeftovers = false
            }
            val s = Session(context, config, agent, label, CoroutineScope(SupervisorJob() + Dispatchers.IO))
            // The framework's bus has no replay: subscribe before anything can be published.
            s.scope.launch(start = CoroutineStart.UNDISPATCHED) {
                agent.eventBus.events.collect { onAgentEvent(s, it) }
            }
            try {
                agent.initialize()
                attachLifecycle(s)
                s.log(LogLevel.Info, "wallet ready")
                return s
            } catch (e: CancellationException) {
                close(s)
                throw e
            } catch (e: Exception) {
                val message = e.message.orEmpty()
                if (message.startsWith("Wallet open failed") || message.startsWith("Wallet creation failed")) {
                    close(s)
                    throw OneTwoIdException.WalletKeyLost(e)
                }
                // Connections created after mediation carry the mediator id; the mediator connection does not.
                val hasOrganisationConnections = runCatching {
                    agent.connectionRepository.getAll().any { it.mediatorId != null }
                }.getOrDefault(true)
                close(s)
                when (MediatorInvitationPolicy.afterMediationFailure(hasOrganisationConnections, retried)) {
                    MediatorInvitationPolicy.Recovery.FetchNewAndRetry -> {
                        s.log(LogLevel.Warn, "mediation failed; retrying once with a new invitation", e)
                        invitation = fetchInvitation(platform, store)
                        retried = true
                    }
                    MediatorInvitationPolicy.Recovery.GiveUp -> throw OneTwoIdException.MediatorUnavailable(e)
                }
            }
        }
    }

    private suspend fun fetchInvitation(platform: PlatformClient, store: SdkStore): String =
        platform.mediatorInvitation().also { url -> store.update { it.copy(mediatorInvitationUrl = url) } }

    private fun agentConfig(walletKey: String, genesisPath: String, invitation: String, label: String) = AgentConfig(
        walletKey = walletKey,
        genesisPath = genesisPath,
        walletId = WALLET_ID,
        mediatorConnectionsInvite = invitation,
        // 4-init §2.7.3: the only strategy that delivers both live and queued messages.
        mediatorPickupStrategy = MediatorPickupStrategy.PickUpV1,
        label = label,
        autoAcceptCredential = AutoAcceptCredential.Never,
        autoAcceptProof = AutoAcceptProof.Never,
        useLegacyDidSovPrefix = true,
        preferredHandshakeProtocol = HandshakeProtocol.Connections,
    )

    private fun stateStore(context: Context) = SdkStore(File(context.noBackupFilesDir, STATE_DIRECTORY))

    private suspend fun attachLifecycle(s: Session) {
        val observer = object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) {
                s.log(LogLevel.Debug, "app in foreground: polling the mediator")
                s.scope.launch {
                    runCatching { s.agent.mediationRecipient.startPickup() }
                        .onFailure { s.log(LogLevel.Warn, "could not resume mediator polling", it) }
                }
            }

            override fun onStop(owner: LifecycleOwner) {
                s.log(LogLevel.Debug, "app in background: mediator polling paused")
                s.agent.mediationRecipient.stopPickup()
            }
        }
        withContext(Dispatchers.Main) {
            val lifecycle = ProcessLifecycleOwner.get().lifecycle
            // Opened in the background (push wake): do not keep polling; sync() collects instead.
            if (!lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) {
                s.log(LogLevel.Debug, "opened in the background (${lifecycle.currentState}): mediator polling paused")
                s.agent.mediationRecipient.stopPickup()
            }
            lifecycle.addObserver(observer)
        }
        s.lifecycleObserver = observer
    }

    private suspend fun close(s: Session) {
        s.scope.cancel()
        s.lifecycleObserver?.let { observer ->
            runCatching { withContext(Dispatchers.Main) { ProcessLifecycleOwner.get().lifecycle.removeObserver(observer) } }
        }
        runCatching { s.agent.shutdown() }
        runCatching { s.agent.ledgerService.close() }
    }

    // --- events ----------------------------------------------------------------------------------

    private suspend fun onAgentEvent(s: Session, event: Any) {
        val mapped = when (event) {
            is AgentEvents.ConnectionEvent ->
                if (event.record.state == ConnectionState.Complete && event.record.mediatorId != null) {
                    WalletEvent.ConnectionCompleted(event.record.id)
                } else {
                    null
                }
            is AgentEvents.CredentialEvent -> when (event.record.state) {
                CredentialState.OfferReceived -> {
                    s.offersReceived.incrementAndGet()
                    WalletEvent.OfferReceived(event.record.id)
                }
                CredentialState.Done -> event.record.credentials.firstOrNull()?.let {
                    s.credentialsStored.incrementAndGet()
                    WalletEvent.CredentialStored(event.record.id, it.credentialRecordId)
                }
                else -> null
            }
            is AgentEvents.ProofEvent -> when (event.record.state) {
                ProofState.RequestReceived -> {
                    s.proofRequestsReceived.incrementAndGet()
                    WalletEvent.ProofRequested(event.record.id)
                }
                ProofState.PresentationSent -> WalletEvent.ProofSent(event.record.id)
                else -> null
            }
            is AgentEvents.ProblemReportEvent -> {
                val description = event.message.description
                WalletEvent.ExchangeFailed(exchangeIdForThread(s, event.message.threadId), description.code.ifEmpty { description.en })
            }
            else -> null
        }
        mapped?.let(::emit)
    }

    private fun emit(event: WalletEvent) {
        _events.tryEmit(event)
        listeners.forEach { runCatching { it.onEvent(event) } }
    }

    private suspend fun exchangeIdForThread(s: Session, threadId: String): String? = runCatching {
        s.agent.credentialExchangeRepository.findByQuery(tagQuery("threadId", threadId)).firstOrNull()?.id
            ?: s.agent.proofRepository.findByQuery(tagQuery("threadId", threadId)).firstOrNull()?.id
    }.getOrNull()

    // --- helpers ---------------------------------------------------------------------------------

    private suspend fun <T> withSession(block: suspend (Session) -> T): T {
        val s = session ?: throw OneTwoIdException.NotInitialized()
        return withContext(Dispatchers.IO) {
            try {
                block(s)
            } catch (e: CancellationException) {
                throw e
            } catch (e: OneTwoIdException) {
                throw e
            } catch (e: Throwable) {
                s.log(LogLevel.Error, "wallet operation failed", e)
                throw OneTwoIdException.Internal(e.message ?: e.javaClass.simpleName, e)
            }
        }
    }

    private suspend fun requireOffer(s: Session, id: String): CredentialExchangeRecord {
        val record = s.agent.credentialExchangeRepository.findById(id)
        if (record == null || record.state != CredentialState.OfferReceived) throw OneTwoIdException.NotFound(id)
        return record
    }

    private suspend fun requireProofRequest(s: Session, id: String) {
        val record = s.agent.proofRepository.findById(id)
        if (record == null || record.state != ProofState.RequestReceived) throw OneTwoIdException.NotFound(id)
    }

    private suspend fun offer(s: Session, record: CredentialExchangeRecord): CredentialOffer {
        // processOffer stores the message, not its content, on the record.
        val message = s.agent.credentials.findOfferMessage(record.id)
        return CredentialOffer(
            id = record.id,
            connectionId = record.connectionId,
            connectionLabel = connectionLabel(s, record.connectionId),
            credentialDefinitionId = message?.let { runCatching { Mappers.credentialDefinitionIdFromOffer(it.getCredentialOffer()) }.getOrNull() },
            attributes = message?.credentialPreview?.attributes?.associate { it.name to it.value }.orEmpty(),
            receivedAtEpochSeconds = record.createdAt.epochSeconds,
        )
    }

    private suspend fun indyProofRequest(s: Session, recordId: String): IndyProofRequest {
        val messageJson = s.agent.didCommMessageRepository.getAgentMessage(recordId, RequestPresentationMessage.type)
        val message = MessageSerializer.decodeFromString(messageJson) as RequestPresentationMessage
        return Mappers.decodeProofRequest(message.indyProofRequest())
    }

    private suspend fun connectionLabel(s: Session, connectionId: String): String? =
        runCatching { s.agent.connectionRepository.getById(connectionId).theirLabel }.getOrNull()

    private fun tagQuery(tag: String, value: String) = "{\"$tag\": \"$value\"}"

    private class Session(
        val context: Context,
        val config: OneTwoIdConfig,
        val agent: Agent,
        val label: String,
        val scope: CoroutineScope,
    ) {
        val offersReceived = AtomicInteger()
        val proofRequestsReceived = AtomicInteger()
        val credentialsStored = AtomicInteger()

        @Volatile var lifecycleObserver: DefaultLifecycleObserver? = null

        fun log(level: LogLevel, message: String, error: Throwable? = null) = SdkLog.log(level, message, error)
    }
}
