package com.onetwoid.sdk.internal

/**
 * Which mediator invitation to use, and whether a failed mediation may be retried with a new one.
 *
 * Two framework facts drive this (Phase 5 plan S):
 * - `MediationRecipient.assertInvitationUrl` deletes the mediation record when the invitation differs
 *   from the stored one, so a wallet must keep presenting the invitation it onboarded with.
 * - A spent single-use invitation fails silently: the holder only sees a timeout (Phase 3 trap 31).
 *   The failure cannot be told apart from a network problem, so the decision must not depend on it.
 */
internal object MediatorInvitationPolicy {

    sealed class Start {
        /** First onboarding: fetch an invitation from the platform. */
        object FetchNew : Start()

        /** Every later launch: the invitation this wallet mediated through, unchanged. */
        data class UsePersisted(val invitationUrl: String) : Start()
    }

    enum class Recovery {
        /** Mint a new invitation, persist it and initialise once more. */
        FetchNewAndRetry,

        /** Report the mediator as unavailable; the next initialise tries the same invitation again. */
        GiveUp,
    }

    fun start(persistedInvitationUrl: String?): Start =
        persistedInvitationUrl?.let { Start.UsePersisted(it) } ?: Start.FetchNew

    /**
     * After mediation failed. Re-mediating is only safe while the wallet has no connections to
     * organisations: their DID documents carry routing keys registered with the old mediation, and
     * messages for them would be lost silently.
     */
    fun afterMediationFailure(hasOrganisationConnections: Boolean, alreadyRetried: Boolean): Recovery =
        if (alreadyRetried || hasOrganisationConnections) Recovery.GiveUp else Recovery.FetchNewAndRetry
}
