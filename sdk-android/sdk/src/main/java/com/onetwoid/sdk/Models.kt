package com.onetwoid.sdk

/** Lifecycle of the wallet inside this process. */
public sealed class WalletState {
    public object Uninitialized : WalletState()
    public object Initializing : WalletState()
    public object Ready : WalletState()
    public class Failed(public val error: OneTwoIdException) : WalletState()
}

/** Whether a connection with an issuer or verifier can carry exchanges yet. */
public enum class ConnectionStatus { Pending, Connected }

/** A pairwise connection with an organisation. */
public data class Connection(
    val id: String,
    /** The organisation's display name, when it sent one. */
    val label: String?,
    val status: ConnectionStatus,
    val createdAtEpochSeconds: Long,
)

/** A credential stored in the wallet. */
public data class Credential(
    val id: String,
    val schemaName: String,
    val schemaVersion: String,
    val credentialDefinitionId: String,
    val attributes: Map<String, String>,
    /** From the platform's mandatory `expiresAt` attribute (epoch seconds), when present and numeric. */
    val expiresAtEpochSeconds: Long?,
) {
    /** True once [expiresAtEpochSeconds] has passed. Verifiers will then refuse proofs from this credential. */
    public fun isExpired(nowEpochSeconds: Long = System.currentTimeMillis() / 1000): Boolean =
        expiresAtEpochSeconds != null && expiresAtEpochSeconds < nowEpochSeconds
}

/** A credential an organisation offers; accept or decline it. */
public data class CredentialOffer(
    val id: String,
    val connectionId: String,
    val connectionLabel: String?,
    val credentialDefinitionId: String?,
    val attributes: Map<String, String>,
    val receivedAtEpochSeconds: Long,
    /** Set when the organisation requires a face check first ([OneTwoId.verifyFace]); null otherwise or when unknown offline. */
    val biometric: BiometricRequirement? = null,
)

/** One group of attributes a verifier asks to see, all from the same credential. */
public data class RequestedAttributeGroup(val key: String, val attributeNames: List<String>)

/** A condition a verifier asks to be proven without revealing the value, e.g. `expiresAt >= now`. */
public data class RequestedPredicate(val key: String, val attributeName: String, val operator: String, val value: Int)

/** A proof request from a verifier; respond with a [ProofSelection] or decline it. */
public data class ProofRequest(
    val id: String,
    val connectionId: String,
    val connectionLabel: String?,
    val name: String,
    val attributeGroups: List<RequestedAttributeGroup>,
    val predicates: List<RequestedPredicate>,
    val receivedAtEpochSeconds: Long,
    /** Set when the verifier requires a face check first ([OneTwoId.verifyFace]); null otherwise or when unknown offline. */
    val biometric: BiometricRequirement? = null,
)

/** A stored credential that can answer one group or predicate of a proof request. */
public data class CredentialCandidate(
    val credentialId: String,
    val credentialDefinitionId: String,
    val attributes: Map<String, String>,
)

/**
 * Candidates per group key. An empty list means the wallet cannot answer that group, so the
 * request cannot be satisfied.
 */
public data class ProofRequestOptions(
    val requestId: String,
    val attributeGroups: Map<String, List<CredentialCandidate>>,
    val predicates: Map<String, List<CredentialCandidate>>,
) {
    /** True when every group and predicate has at least one candidate. */
    public val isSatisfiable: Boolean
        get() = attributeGroups.values.all { it.isNotEmpty() } && predicates.values.all { it.isNotEmpty() }

    /** A selection using the first candidate everywhere, or null when the request is not satisfiable. */
    public fun defaultSelection(): ProofSelection? {
        if (!isSatisfiable) return null
        return ProofSelection(
            attributeGroups = attributeGroups.mapValues { it.value.first().credentialId },
            predicates = predicates.mapValues { it.value.first().credentialId },
        )
    }
}

/** The credential chosen for each group key and predicate key of a proof request. */
public data class ProofSelection(
    val attributeGroups: Map<String, String>,
    val predicates: Map<String, String>,
)

/** What one [OneTwoId.sync] collected. */
public data class SyncResult(
    val offersReceived: Int,
    val proofRequestsReceived: Int,
    val credentialsStored: Int,
    /** False when the timeout ended the sync before the mediator reported an empty queue. */
    val drained: Boolean,
)

/** Changes the host app may want to react to. Load details with the matching query function. */
public sealed class WalletEvent {
    public data class ConnectionCompleted(val connectionId: String) : WalletEvent()
    public data class OfferReceived(val offerId: String) : WalletEvent()
    public data class CredentialStored(val offerId: String, val credentialId: String) : WalletEvent()
    public data class ProofRequested(val requestId: String) : WalletEvent()
    public data class ProofSent(val requestId: String) : WalletEvent()
    /** An exchange ended without success, e.g. the organisation sent a problem report. */
    public data class ExchangeFailed(val exchangeId: String?, val reason: String) : WalletEvent()
}

/** Receives [WalletEvent]s for callers that do not collect [OneTwoId.events]. */
public fun interface WalletListener {
    public fun onEvent(event: WalletEvent)
}
