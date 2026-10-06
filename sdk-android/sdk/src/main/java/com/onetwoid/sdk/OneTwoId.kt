package com.onetwoid.sdk

import android.content.Context
import android.content.pm.ApplicationInfo
import android.util.Base64
import androidx.activity.ComponentActivity
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import com.onetwoid.sdk.internal.BiometricMapping
import com.onetwoid.sdk.internal.checkApiBaseUrl
import com.onetwoid.sdk.internal.checkGenesisPublicKeys
import com.onetwoid.sdk.internal.CaptureModuleDto
import com.onetwoid.sdk.internal.checkIdlePollInterval
import com.onetwoid.sdk.internal.DeliveryScheduler
import com.onetwoid.sdk.internal.GenesisCache
import com.onetwoid.sdk.internal.KeystoreKeyWrapper
import com.onetwoid.sdk.internal.Mappers
import com.onetwoid.sdk.internal.MediatorInvitationPolicy
import com.onetwoid.sdk.internal.PickupRunner
import com.onetwoid.sdk.internal.PlatformClient
import com.onetwoid.sdk.internal.PlatformRefusal
import com.onetwoid.sdk.internal.SdkLog
import com.onetwoid.sdk.internal.SdkStore
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
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
import java.util.concurrent.ConcurrentHashMap
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

    /** How long the wallet polls for an expected reply (on-demand delivery). */
    private val WINDOW = 30.seconds
    private val MAX_WINDOW = 120.seconds

    private val initMutex = Mutex()
    private val _state = MutableStateFlow<WalletState>(WalletState.Uninitialized)
    private val _events = MutableSharedFlow<WalletEvent>(extraBufferCapacity = 64)
    private val listeners = CopyOnWriteArrayList<WalletListener>()
    private val captures = ConcurrentHashMap<String, BiometricCapture>()

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
     * Registers a face-capture add-on (e.g. `AwsFaceLivenessCapture` from
     * `com.12id:holder-sdk-android-biometrics-aws`). Call it next to [initialize]; one add-on per provider.
     */
    public fun registerCapture(capture: BiometricCapture) {
        captures[capture.provider] = capture
    }

    /**
     * Opens the wallet: on first launch creates it, fetches the ledger genesis and connects to the
     * mediator through this installation's single-use invitation. Later launches reuse all of that.
     */
    public suspend fun initialize(context: Context, config: OneTwoIdConfig) {
        val appContext = context.applicationContext ?: context
        lastInit = appContext to config
        SdkLog.sink = config.logSink
        SdkLog.minLevel = config.minLogLevel
        // The wallet token travels on this URL; cleartext is only blocked by Android itself from API 28.
        checkApiBaseUrl(config.apiBaseUrl, (appContext.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0)
        checkIdlePollInterval(config.idlePollInterval)
        checkGenesisPublicKeys(config.genesisPublicKeys)
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

    /**
     * Accepts an organisation's connection invitation (the `?oob=` / `?c_i=` URL or its QR payload).
     * The wallet then polls briefly for the organisation's answer ([WalletEvent.ConnectionCompleted]).
     */
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
        if (record == null) throw OneTwoIdException.InvalidInvitation()
        // The organisation's connection response comes back through the mediator.
        if (record.state != ConnectionState.Complete) {
            s.delivery.open(WINDOW) { it is WalletEvent.ConnectionCompleted && it.connectionId == record.id }
        }
        Mappers.connection(record)
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
        val records = s.agent.credentialExchangeRepository.findByQuery(tagQuery("state", CredentialState.OfferReceived.name))
            .filter { it.protocolVersion == "v1" }
        val requirements = requirementsByThread(s, records.map { it.threadId })
        records.map { offer(s, it).copy(biometric = requirements[it.threadId]) }
    }

    /** Requests the credential; it is stored when the organisation issues it ([WalletEvent.CredentialStored]). */
    public suspend fun acceptOffer(id: String): Unit = withSession { s ->
        val record = requireOffer(s, id)
        BiometricMapping.guard(id, requirementsByThread(s, listOf(record.threadId))[record.threadId])
        // The per-record Always makes the framework store and acknowledge the credential when it arrives.
        s.agent.credentials.acceptOffer(AcceptOfferOptions(credentialRecordId = id, autoAcceptCredential = AutoAcceptCredential.Always))
        // The issued credential comes back through the mediator.
        s.delivery.open(WINDOW) {
            (it is WalletEvent.CredentialStored && it.offerId == id) || (it is WalletEvent.ExchangeFailed && it.exchangeId == id)
        }
    }

    public suspend fun declineOffer(id: String): Unit = withSession { s ->
        requireOffer(s, id)
        s.agent.credentials.declineOffer(AcceptOfferOptions(credentialRecordId = id))
        Unit
    }

    public suspend fun pendingProofRequests(): List<ProofRequest> = withSession { s ->
        val records = s.agent.proofRepository.findByQuery(tagQuery("state", ProofState.RequestReceived.name))
        val requirements = requirementsByThread(s, records.map { it.threadId })
        records.map { record ->
            Mappers.proofRequest(
                id = record.id,
                connectionId = record.connectionId,
                connectionLabel = connectionLabel(s, record.connectionId),
                receivedAtEpochSeconds = record.createdAt.epochSeconds,
                request = indyProofRequest(s, record.id),
            ).copy(biometric = requirements[record.threadId])
        }
    }

    /** The stored credentials that can answer each group of the request. */
    public suspend fun proofRequestOptions(id: String): ProofRequestOptions = withSession { s ->
        requireProofRequest(s, id)
        Mappers.proofRequestOptions(id, s.agent.proofs.getRequestedCredentialsForProofRequest(id))
    }

    /** Sends a proof built from the chosen credentials. */
    public suspend fun respondToProofRequest(id: String, selection: ProofSelection): Unit = withSession { s ->
        val threadId = requireProofRequest(s, id)
        // Before building the proof: a presentation sent without a pass is withheld by the platform anyway.
        BiometricMapping.guard(id, requirementsByThread(s, listOf(threadId))[threadId])
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
     * The face check the organisation requires for this offer or proof request, or null when none is
     * required. Asks the platform, so it needs the network.
     */
    public suspend fun biometricRequirement(exchangeId: String): BiometricRequirement? = withSession { s ->
        val threadId = threadIdOf(s, exchangeId) ?: throw OneTwoIdException.NotFound(exchangeId)
        s.platform.biometricRequirements(listOf(threadId)).firstOrNull()?.let(BiometricMapping::requirement)
    }

    /**
     * Runs the face check for an offer or proof request: starts a session on the platform, shows the
     * registered capture add-on's screen, and returns the platform's decision. Each call uses one attempt.
     * On [BiometricOutcome.Passed], call [acceptOffer] or [respondToProofRequest].
     *
     * Needs an activity for the camera UI and the camera permission, which the add-on requests.
     */
    public suspend fun verifyFace(activity: ComponentActivity, exchangeId: String): BiometricOutcome = withSession { s ->
        val threadId = threadIdOf(s, exchangeId) ?: throw OneTwoIdException.NotFound(exchangeId)
        val requirement = s.platform.biometricRequirements(listOf(threadId)).firstOrNull()?.let(BiometricMapping::requirement)
            ?: return@withSession BiometricOutcome.Passed
        when (requirement.status) {
            BiometricStatus.Passed -> return@withSession BiometricOutcome.Passed
            BiometricStatus.Pending -> Unit
            else -> return@withSession BiometricOutcome.Locked
        }
        val capture = captures[requirement.provider] ?: throw OneTwoIdException.BiometricCaptureUnavailable(requirement.provider)

        val started = try {
            s.platform.startBiometricSession(threadId, captures.values.map { CaptureModuleDto(it.provider, it.version) })
        } catch (e: PlatformRefusal) {
            when {
                e.code == "capture_module_missing" -> throw OneTwoIdException.BiometricCaptureUnavailable(requirement.provider)
                e.code.startsWith("check_") || e.code == "attempts_exhausted" -> return@withSession BiometricOutcome.Locked
                else -> throw OneTwoIdException.PlatformError(e.status, "${e.code}: ${e.reason}")
            }
        }
        s.log(LogLevel.Info, "biometric session started (attempt ${started.attempt}, provider ${started.provider})")

        val output = withContext(Dispatchers.Main) {
            capture.capture(activity, CaptureSession(started.provider, started.clientConfig?.toString() ?: "{}", started.attempt))
        }

        // The vendor may still be processing the capture: the platform answers result_not_ready.
        repeat(BiometricMapping.RESULT_POLLS) {
            try {
                return@withSession BiometricMapping.outcome(s.platform.completeBiometricSession(started.sessionId, output.clientOutputJson))
            } catch (e: PlatformRefusal) {
                if (e.code != "result_not_ready") throw OneTwoIdException.PlatformError(e.status, "${e.code}: ${e.reason}")
                delay(BiometricMapping.RESULT_POLL_DELAY_MS)
            }
        }
        throw OneTwoIdException.NetworkUnavailable(IllegalStateException("the biometric result did not arrive in time"))
    }

    /**
     * Tells the wallet a message is on its way, so it polls the mediator until the first offer or proof
     * request arrives, or for at most [timeout] (capped at 120 s). Call it when your app asks your
     * backend to start an exchange, e.g. right after sign-in (your backend then offers a credential) or
     * before an action your backend guards with a proof request. Returns at once.
     *
     * Without it, a message the organisation sends while the app is open arrives with your push
     * ([sync]) or the next time the app comes to the foreground: the wallet does not poll while idle
     * unless [OneTwoIdConfig.idlePollInterval] is set.
     */
    public fun expectMessages(timeout: Duration = 30.seconds) {
        val s = session ?: throw OneTwoIdException.NotInitialized()
        s.delivery.open(timeout.coerceIn(1.seconds, MAX_WINDOW)) {
            it is WalletEvent.OfferReceived || it is WalletEvent.ProofRequested || it is WalletEvent.ExchangeFailed
        }
    }

    /**
     * Collects messages queued at the mediator now. Call it from your push handler when your backend
     * receives `wallet.sync_requested`. Opens the wallet first if this process has not done so, using the
     * configuration of the last [initialize] call.
     *
     * Returns when the queue is empty. The wallet then checks the mediator three more times in the next
     * 32 s, because the platform sends at most one `wallet.sync_requested` per wallet every 30 s; keep your
     * worker alive for that with [awaitDelivery].
     */
    public suspend fun sync(timeout: Duration = 20.seconds): SyncResult {
        val s = session ?: lastInit?.let { (context, config) ->
            initialize(context, config)
            session
        } ?: throw OneTwoIdException.NotInitialized()

        val offersBefore = s.offersReceived.get()
        val requestsBefore = s.proofRequestsReceived.get()
        val storedBefore = s.credentialsStored.get()
        val drained = withContext(Dispatchers.IO) { s.pickups.drain("sync", timeout) }
        s.delivery.tail()
        return SyncResult(
            offersReceived = s.offersReceived.get() - offersBefore,
            proofRequestsReceived = s.proofRequestsReceived.get() - requestsBefore,
            credentialsStored = s.credentialsStored.get() - storedBefore,
            drained = drained,
        )
    }

    /**
     * Suspends until the wallet's follow-up polls have finished: the checks after [sync] (at most about
     * 32 s) and any open [connect] / [acceptOffer] / [expectMessages] window. Call it at the end of the
     * worker your push starts, after [sync], so Android keeps the process running for them. Returns at
     * once when nothing is running or the wallet is not open.
     */
    public suspend fun awaitDelivery() {
        session?.delivery?.awaitIdle()
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

        val genesis = GenesisCache(File(store.directory, "genesis"), platform, config.genesisPublicKeys).resolve(state.genesisSha256)
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
            val s = Session(context, config, agent, label, platform, CoroutineScope(SupervisorJob() + Dispatchers.IO))
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
        // No framework timer (fork change F9): the SDK polls on demand through DeliveryScheduler.
        mediatorPollingInterval = 0,
        label = label,
        autoAcceptCredential = AutoAcceptCredential.Never,
        autoAcceptProof = AutoAcceptProof.Never,
        useLegacyDidSovPrefix = true,
        preferredHandshakeProtocol = HandshakeProtocol.Connections,
    )

    private fun stateStore(context: Context) = SdkStore(File(context.noBackupFilesDir, STATE_DIRECTORY))

    private suspend fun attachLifecycle(s: Session) {
        val observer = object : DefaultLifecycleObserver {
            // Also delivered at addObserver when the app is already in the foreground: the first drain.
            override fun onStart(owner: LifecycleOwner) {
                s.log(LogLevel.Debug, "app in foreground: collecting queued messages")
                s.delivery.onForeground()
            }

            override fun onStop(owner: LifecycleOwner) {
                s.log(LogLevel.Debug, "app in background")
                s.delivery.onBackground()
            }
        }
        withContext(Dispatchers.Main) {
            val lifecycle = ProcessLifecycleOwner.get().lifecycle
            // Opened in the background (push wake): nothing polls; sync() collects.
            if (!lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) {
                s.log(LogLevel.Debug, "opened in the background (${lifecycle.currentState})")
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
        mapped?.let {
            s.delivery.signal(it)
            emit(it)
        }
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

    private suspend fun requireProofRequest(s: Session, id: String): String {
        val record = s.agent.proofRepository.findById(id)
        if (record == null || record.state != ProofState.RequestReceived) throw OneTwoIdException.NotFound(id)
        return record.threadId
    }

    private suspend fun threadIdOf(s: Session, exchangeId: String): String? =
        s.agent.credentialExchangeRepository.findById(exchangeId)?.threadId ?: s.agent.proofRepository.findById(exchangeId)?.threadId

    /** Biometric requirements by thread id; empty when the platform cannot be reached (it enforces anyway). */
    private suspend fun requirementsByThread(s: Session, threadIds: List<String>): Map<String, BiometricRequirement> =
        runCatching { s.platform.biometricRequirements(threadIds).associate { it.threadId to BiometricMapping.requirement(it) } }
            .onFailure { s.log(LogLevel.Warn, "biometric requirements unavailable", it) }
            .getOrDefault(emptyMap())

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
        val platform: PlatformClient,
        val scope: CoroutineScope,
    ) {
        val offersReceived = AtomicInteger()
        val proofRequestsReceived = AtomicInteger()
        val credentialsStored = AtomicInteger()
        val pickups = PickupRunner(send = { agent.mediationRecipient.pickupMessages() }, events = agent.eventBus.events)
        val delivery = DeliveryScheduler(scope, pickups, config.idlePollInterval)

        @Volatile var lifecycleObserver: DefaultLifecycleObserver? = null

        fun log(level: LogLevel, message: String, error: Throwable? = null) = SdkLog.log(level, message, error)
    }
}
