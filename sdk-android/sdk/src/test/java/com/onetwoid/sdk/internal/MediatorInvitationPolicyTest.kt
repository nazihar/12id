package com.onetwoid.sdk.internal

import org.junit.Assert.assertEquals
import org.junit.Test

class MediatorInvitationPolicyTest {
    @Test
    fun `first onboarding fetches an invitation`() {
        assertEquals(MediatorInvitationPolicy.Start.FetchNew, MediatorInvitationPolicy.start(null))
    }

    @Test
    fun `later launches reuse the persisted invitation unchanged`() {
        val url = "https://mediator.example/invitation?oob=abc"
        assertEquals(MediatorInvitationPolicy.Start.UsePersisted(url), MediatorInvitationPolicy.start(url))
    }

    @Test
    fun `a wallet without organisation connections retries once with a new invitation`() {
        assertEquals(
            MediatorInvitationPolicy.Recovery.FetchNewAndRetry,
            MediatorInvitationPolicy.afterMediationFailure(hasOrganisationConnections = false, alreadyRetried = false),
        )
    }

    @Test
    fun `a second failure gives up`() {
        assertEquals(
            MediatorInvitationPolicy.Recovery.GiveUp,
            MediatorInvitationPolicy.afterMediationFailure(hasOrganisationConnections = false, alreadyRetried = true),
        )
    }

    @Test
    fun `a wallet with organisation connections never re-mediates`() {
        assertEquals(
            MediatorInvitationPolicy.Recovery.GiveUp,
            MediatorInvitationPolicy.afterMediationFailure(hasOrganisationConnections = true, alreadyRetried = false),
        )
    }
}
