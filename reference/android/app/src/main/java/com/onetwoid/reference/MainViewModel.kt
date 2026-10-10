package com.onetwoid.reference

import android.app.Application
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.onetwoid.sdk.BiometricOutcome
import com.onetwoid.sdk.Credential
import com.onetwoid.sdk.CredentialOffer
import com.onetwoid.sdk.OneTwoIdException
import com.onetwoid.sdk.ProofRequest
import com.onetwoid.sdk.WalletEvent
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

sealed interface Screen {
    data object SignIn : Screen
    data class Working(val message: String) : Screen

    /** The organisation uses face checks and needs a photo of this user first. */
    data object Photo : Screen
    data object Home : Screen
    data object ActionForm : Screen
    data class ActionWaiting(val details: Map<String, String>, val message: String) : Screen
    data class ActionDone(val approved: Boolean, val details: Map<String, String>, val shared: Map<String, String>) : Screen
}

data class Ui(
    val screen: Screen = Screen.SignIn,
    val user: Backend.User? = null,
    val card: Credential? = null,
    /** A credential the organisation wants to give; shown as a dialog until the user answers. */
    val offer: CredentialOffer? = null,
    /** A proof request that waits for the user's approval. */
    val request: ProofRequest? = null,
    val busy: Boolean = false,
    val error: String? = null,
)

/**
 * The two flows of the SDK guide's recipe, started by the app:
 *  - sign-in → connect → the organisation offers a credential → the user accepts it;
 *  - an action → the organisation asks for a proof → the user approves → the backend allows the action.
 * Where the organisation requires it, a face check comes before the accept and before the approval.
 */
class MainViewModel(application: Application) : AndroidViewModel(application) {
    private val app = application as ReferenceApp
    private val backend = app.backend
    private val wallet = app.wallet
    private val skin = Skins.current

    private val _ui = MutableStateFlow(Ui())
    val ui: StateFlow<Ui> = _ui.asStateFlow()

    private var waiting: Job? = null
    private var actionId: String? = null

    init {
        viewModelScope.launch { wallet.events.collect(::onEvent) }
        if (backend.signedIn) setUp()
    }

    fun signIn(name: String, accessCode: String) = task("Sign-in failed") {
        val user = backend.signIn(name.trim(), accessCode.trim())
        _ui.update { it.copy(user = user) }
        setUp()
    }

    /** Opens the wallet and, when it holds no card yet, asks the backend to enrol this user. */
    fun setUp() = task("Could not set up your wallet") {
        show(Screen.Working("Opening your wallet…"))
        wallet.open()
        val user = backend.me()
        _ui.update { it.copy(user = user) }
        refresh()
        if (_ui.value.card != null) return@task show(Screen.Home)
        // First sign-in at an organisation that uses face checks: it needs the user's photo before it issues.
        if (user.photoRequired) return@task show(Screen.Photo)

        show(Screen.Working("Connecting to ${skin.organisation}…"))
        val enrolment = backend.enrol()
        // The backend offers the card as soon as 12id tells it the connection is complete.
        if (enrolment.invitationUrl != null) wallet.connect(enrolment.invitationUrl) else wallet.expect(60)
        show(Screen.Working("Waiting for your ${skin.cardTitle} card…"))
        refresh()
        giveUpAfter(60, "Your card did not arrive. Try again.")
    }

    /** The photo the user just took becomes their photo on file at the backend; then enrolment goes on. */
    fun submitPhoto(jpeg: ByteArray) = task("Could not save your photo") {
        show(Screen.Working("Saving your photo…"))
        backend.uploadPhoto(jpeg)
        setUp()
    }

    fun acceptOffer(activity: ComponentActivity) = task("Could not accept") {
        val offer = _ui.value.offer ?: return@task
        if (wallet.needsFaceCheck(offer) && !faceCheck(activity, offer.id)) return@task
        _ui.update { it.copy(offer = null, screen = Screen.Working("Receiving your card…")) }
        wallet.accept(offer)
        giveUpAfter(60, "Your card did not arrive. Try again.")
    }

    fun declineOffer() = task("Could not decline") {
        val offer = _ui.value.offer ?: return@task
        waiting?.cancel()
        _ui.update { it.copy(offer = null, screen = Screen.Home) }
        wallet.decline(offer)
    }

    fun openActionForm() = show(Screen.ActionForm)

    fun backHome() {
        waiting?.cancel()
        actionId = null
        show(Screen.Home)
    }

    /** Asks the backend to start the action and tells the wallet that a proof request is coming. */
    fun startAction(details: Map<String, String>) = task("Could not start") {
        show(Screen.ActionWaiting(details, "Asking ${skin.organisation}…"))
        // A request left over from an earlier attempt would be mistaken for this one.
        wallet.pendingRequest()?.let { wallet.decline(it) }
        _ui.update { it.copy(request = null) }
        actionId = backend.startAction(skin.action.type, details)
        wallet.expect()
        giveUpAfter(45, "No request arrived. Try again.")
    }

    fun approveRequest(activity: ComponentActivity) = task("Could not approve") {
        val request = _ui.value.request ?: return@task
        val screen = _ui.value.screen as? Screen.ActionWaiting ?: return@task
        if (wallet.needsFaceCheck(request) && !faceCheck(activity, request.id)) return@task
        waiting?.cancel()
        _ui.update { it.copy(request = null, screen = screen.copy(message = "Sending your approval…")) }
        if (!wallet.approve(request)) return@task fail("Your card cannot answer this request.")

        // The proof goes to 12id, which checks it and tells the backend; the app reads the backend's decision.
        val id = actionId ?: return@task
        repeat(60) {
            val result = backend.action(id)
            if (result.state != "pending") return@task show(Screen.ActionDone(result.state == "approved", screen.details, result.disclosed))
            delay(1_000)
        }
        fail("${skin.organisation} did not answer. Try again.")
    }

    fun declineRequest() = task("Could not decline") {
        val request = _ui.value.request ?: return@task
        val screen = _ui.value.screen as? Screen.ActionWaiting
        waiting?.cancel()
        _ui.update { it.copy(request = null, screen = Screen.ActionDone(false, screen?.details.orEmpty(), emptyMap())) }
        wallet.decline(request)
    }

    /**
     * Runs the organisation's face check for an offer or a proof request. True when it passed; otherwise
     * the dialog stays, with a message, until the attempts run out and the organisation cancels.
     */
    private suspend fun faceCheck(activity: ComponentActivity, exchangeId: String): Boolean {
        val outcome = try {
            wallet.verifyFace(activity, exchangeId)
        } catch (e: OneTwoIdException.BiometricCancelled) {
            _ui.update { it.copy(error = "The face check was not finished.") }
            return false
        }
        return when (outcome) {
            BiometricOutcome.Passed -> true
            is BiometricOutcome.Failed -> {
                refresh()
                _ui.update { it.copy(error = "The face check did not pass. ${outcome.attemptsRemaining} attempts left.") }
                false
            }
            BiometricOutcome.Locked -> {
                refresh()
                fail("The face check did not pass, and ${skin.organisation} cancelled the request.")
                false
            }
        }
    }

    /** Deletes the wallet and signs out; the next sign-in is a new user with a new card. */
    fun reset() = task("Could not reset") {
        waiting?.cancel()
        runCatching { wallet.reset() }.onFailure { Log.w(TAG, "wallet reset", it) }
        backend.forget()
        actionId = null
        _ui.value = Ui()
    }

    fun clearError() = _ui.update { it.copy(error = null) }

    private suspend fun onEvent(event: WalletEvent) {
        when (event) {
            is WalletEvent.OfferReceived, is WalletEvent.ProofRequested -> refresh()
            is WalletEvent.CredentialStored -> {
                waiting?.cancel()
                refresh()
                if (_ui.value.screen is Screen.Working) show(Screen.Home)
            }
            is WalletEvent.ExchangeFailed -> {
                refresh()
                fail("${skin.organisation} cancelled the request.")
            }
            else -> Unit
        }
    }

    private suspend fun refresh() {
        val card = wallet.card()
        val offer = if (card == null) wallet.pendingOffer() else null
        // A proof request is only shown while an action is waiting for one.
        val request = if (_ui.value.screen is Screen.ActionWaiting) wallet.pendingRequest() else null
        _ui.update { it.copy(card = card, offer = offer, request = request) }
    }

    private fun show(screen: Screen) = _ui.update { it.copy(screen = screen) }

    /** Back to the home screen with a message; from there the user can try again. */
    private fun fail(message: String) {
        waiting?.cancel()
        _ui.update { it.copy(error = message, screen = if (backend.signedIn) Screen.Home else Screen.SignIn) }
    }

    /** Nothing in 12id is instant, and nothing is guaranteed to arrive: every wait has an end. */
    private fun giveUpAfter(seconds: Int, message: String) {
        waiting?.cancel()
        waiting = viewModelScope.launch {
            delay(seconds * 1_000L)
            val screen = _ui.value.screen
            val stillWaiting = screen is Screen.Working || (screen is Screen.ActionWaiting && _ui.value.request == null)
            if (stillWaiting && _ui.value.offer == null) fail(message)
        }
    }

    private fun task(failure: String, block: suspend () -> Unit) {
        viewModelScope.launch {
            _ui.update { it.copy(busy = true, error = null) }
            try {
                block()
            } catch (e: Backend.Refused) {
                Log.w(TAG, failure, e)
                when (e.code) {
                    "wrong_access_code" -> _ui.update { it.copy(error = "That access code is not right.") }
                    // The backend no longer knows this session (or this installation): start over.
                    // The organisation requires a face check for this and has no photo of the user yet.
                    "photo_required" -> show(Screen.Photo)
                    "not_signed_in" -> {
                        backend.forget()
                        _ui.value = Ui(error = "Please sign in again.")
                    }
                    else -> fail("$failure (${e.code}).")
                }
            } catch (e: Exception) {
                Log.w(TAG, failure, e)
                fail("$failure: ${e.message ?: e.javaClass.simpleName}")
            } finally {
                _ui.update { it.copy(busy = false) }
            }
        }
    }

    private companion object {
        const val TAG = "reference-app"
    }
}
