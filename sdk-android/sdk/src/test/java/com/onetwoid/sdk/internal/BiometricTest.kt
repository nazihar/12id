package com.onetwoid.sdk.internal

import com.onetwoid.sdk.BiometricOutcome
import com.onetwoid.sdk.BiometricRequirement
import com.onetwoid.sdk.BiometricStatus
import com.onetwoid.sdk.OneTwoIdException
import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

/** Phase 6 biometric gate: mapping, the client-side guard, and the three wallet routes. */
class BiometricTest {
    private lateinit var server: MockWebServer

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private fun client(tokens: MutableList<String> = mutableListOf("t1")) =
        PlatformClient(server.url("/").toString(), walletTokenProvider = { tokens.removeAt(0) })

    @Test
    fun `maps platform requirements and outcomes`() {
        val req = BiometricMapping.requirement(BiometricRequirementDto("th", "credential", "pending", 2, "aws-rekognition", "2026-09-21T10:00:00.000Z"))
        assertEquals(BiometricRequirement(BiometricStatus.Pending, 2, "aws-rekognition", 1789984800), req)
        assertEquals(BiometricStatus.Cancelled, BiometricMapping.requirement(BiometricRequirementDto("th", "proof", "cancelled", 0, "p", "bad")).status)

        assertEquals(BiometricOutcome.Passed, BiometricMapping.outcome(SessionOutcomeDto("passed", 0)))
        assertEquals(BiometricOutcome.Failed(1), BiometricMapping.outcome(SessionOutcomeDto("failed", 1)))
        assertEquals(BiometricOutcome.Locked, BiometricMapping.outcome(SessionOutcomeDto("locked", 0)))
    }

    @Test
    fun `guard blocks pending and failed checks, lets passed and unknown through`() {
        BiometricMapping.guard("x", null)
        BiometricMapping.guard("x", BiometricRequirement(BiometricStatus.Passed, 0, "p", 0))
        try {
            BiometricMapping.guard("x", BiometricRequirement(BiometricStatus.Pending, 3, "p", 0))
            fail("expected BiometricRequired")
        } catch (e: OneTwoIdException.BiometricRequired) {
            assertEquals("x", e.exchangeId)
        }
        try {
            BiometricMapping.guard("x", BiometricRequirement(BiometricStatus.Expired, 0, "p", 0))
            fail("expected BiometricFailed")
        } catch (_: OneTwoIdException.BiometricFailed) {
        }
    }

    @Test
    fun `requirements query every thread and omit nothing the platform returned`() = runTest {
        server.enqueue(MockResponse().setBody("""{"requirements":[{"threadId":"a","recordType":"credential","status":"pending","attemptsRemaining":3,"captureProvider":"mock","expiresAt":"2026-09-21T10:00:00.000Z","extra":1}]}"""))
        val result = client().biometricRequirements(listOf("a", "b"))
        assertEquals(listOf("a"), result.map { it.threadId })
        val request = server.takeRequest()
        assertEquals("/v1/wallet/biometric-requirements?threadId=a&threadId=b", request.path)
        assertEquals("Bearer t1", request.getHeader("Authorization"))
    }

    @Test
    fun `no threads means no request`() = runTest {
        assertTrue(client().biometricRequirements(emptyList()).isEmpty())
        assertEquals(0, server.requestCount)
    }

    @Test
    fun `start session retries once with a fresh token and sends the capture modules`() = runTest {
        server.enqueue(MockResponse().setResponseCode(401))
        server.enqueue(MockResponse().setResponseCode(201).setBody("""{"sessionId":"s1","provider":"mock","clientConfig":{"sessionId":"v1"},"attempt":1,"attemptsRemaining":2}"""))
        val started = client(mutableListOf("old", "new")).startBiometricSession("th", listOf(CaptureModuleDto("mock", 1)))
        assertEquals("s1", started.sessionId)
        assertEquals("""{"sessionId":"v1"}""", started.clientConfig.toString())
        server.takeRequest()
        val retried = server.takeRequest()
        assertEquals("Bearer new", retried.getHeader("Authorization"))
        assertEquals("""{"threadId":"th","captureModules":[{"provider":"mock","version":1}]}""", retried.body.readUtf8())
    }

    @Test
    fun `refusals keep the platform error code`() = runTest {
        server.enqueue(MockResponse().setResponseCode(409).setBody("""{"error":"result_not_ready","reason":"still processing"}"""))
        try {
            client().completeBiometricSession("s1", """{"live":true}""")
            fail("expected a refusal")
        } catch (e: PlatformRefusal) {
            assertEquals(409, e.status)
            assertEquals("result_not_ready", e.code)
        }
        assertEquals("""{"clientOutput":{"live":true}}""", server.takeRequest().body.readUtf8())
    }

    @Test
    fun `malformed capture output is sent as an empty object`() = runTest {
        server.enqueue(MockResponse().setBody("""{"outcome":"failed","attemptsRemaining":1}"""))
        val outcome = client().completeBiometricSession("s1", "not json")
        assertEquals("failed", outcome.outcome)
        assertEquals("""{"clientOutput":{}}""", server.takeRequest().body.readUtf8())
    }

    @Test
    fun `a missing clientConfig parses as null`() = runTest {
        server.enqueue(MockResponse().setResponseCode(201).setBody("""{"sessionId":"s1","provider":"mock","attempt":1,"attemptsRemaining":0}"""))
        assertNull(client().startBiometricSession("th", emptyList()).clientConfig)
    }

    @Test
    fun `the wallet token is cached and refreshed only after a 401`() = runTest {
        var providerCalls = 0
        val client = PlatformClient(server.url("/").toString(), walletTokenProvider = { providerCalls++; "t$providerCalls" })
        repeat(3) { server.enqueue(MockResponse().setBody("""{"requirements":[]}""")) }
        repeat(3) { client.biometricRequirements(listOf("a")) }
        assertEquals(1, providerCalls)

        server.enqueue(MockResponse().setResponseCode(401))
        server.enqueue(MockResponse().setBody("""{"requirements":[]}"""))
        client.biometricRequirements(listOf("a"))
        assertEquals(2, providerCalls)
        repeat(3) { server.takeRequest() }
        assertEquals("Bearer t1", server.takeRequest().getHeader("Authorization"))
        assertEquals("Bearer t2", server.takeRequest().getHeader("Authorization"))
    }
}
