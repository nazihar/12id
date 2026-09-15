package com.onetwoid.sdk.internal

import com.onetwoid.sdk.OneTwoIdException
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

class PlatformClientTest {
    private lateinit var server: MockWebServer

    @Before
    fun start() {
        server = MockWebServer().apply { start() }
    }

    @After
    fun stop() {
        server.shutdown()
    }

    private fun client(tokens: MutableList<String>): PlatformClient {
        var calls = 0
        return PlatformClient(server.url("/").toString(), { tokens.getOrElse(calls++) { tokens.last() } })
    }

    @Test
    fun `ledger config is parsed and unknown fields ignored`() = runBlocking {
        server.enqueue(
            MockResponse().setBody(
                """{"indyNamespace":"12id:staging","genesis":{"url":"https://g/v1/genesis","sha256":"ab","signatureUrl":"https://g/sig","signingPublicKey":"k"},"vdrProxyUrl":"https://vdr","extra":true}""",
            ),
        )

        val config = client(mutableListOf("t")).ledgerConfig()

        assertEquals("12id:staging", config.indyNamespace)
        assertEquals("https://g/v1/genesis", config.genesis.url)
        assertEquals("/v1/ledger", server.takeRequest().path)
    }

    @Test
    fun `mediator invitation sends the wallet token`() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"invitationUrl":"https://m/invitation?oob=x"}"""))

        val url = client(mutableListOf("12id_wt_first")).mediatorInvitation()

        assertEquals("https://m/invitation?oob=x", url)
        val request = server.takeRequest()
        assertEquals("/v1/wallet/mediator-invitation", request.path)
        assertEquals("Bearer 12id_wt_first", request.getHeader("Authorization"))
    }

    @Test
    fun `a rejected token is replaced once by asking the provider again`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(401))
        server.enqueue(MockResponse().setBody("""{"invitationUrl":"https://m/i"}"""))

        val url = client(mutableListOf("old", "new")).mediatorInvitation()

        assertEquals("https://m/i", url)
        assertEquals("Bearer old", server.takeRequest().getHeader("Authorization"))
        assertEquals("Bearer new", server.takeRequest().getHeader("Authorization"))
    }

    @Test
    fun `two rejections report WalletTokenRejected`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(401))
        server.enqueue(MockResponse().setResponseCode(401))

        try {
            client(mutableListOf("old", "still-old")).mediatorInvitation()
            fail("expected WalletTokenRejected")
        } catch (e: OneTwoIdException.WalletTokenRejected) {
            assertEquals(2, server.requestCount)
        }
    }

    @Test
    fun `other error statuses report PlatformError with the status`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(409).setBody("""{"error":"wallet_revoked"}"""))

        try {
            client(mutableListOf("t")).mediatorInvitation()
            fail("expected PlatformError")
        } catch (e: OneTwoIdException.PlatformError) {
            assertEquals(409, e.statusCode)
            assertTrue(e.message!!.contains("wallet_revoked"))
        }
    }

    @Test
    fun `an unreachable platform reports NetworkUnavailable`() = runBlocking {
        val url = server.url("/").toString()
        server.shutdown()

        try {
            PlatformClient(url, { "t" }).ledgerConfig()
            fail("expected NetworkUnavailable")
        } catch (e: OneTwoIdException.NetworkUnavailable) {
            // expected
        }
    }
}
