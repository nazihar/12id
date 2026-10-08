package org.hyperledger.ariesframework.agent

import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

// 12id fork change (F10): a 429 is sent again after its Retry-After, and a refused DIDComm POST is a failed send.
class RetryAfterInterceptorTest {
    private lateinit var server: MockWebServer
    private val waits = mutableListOf<Long>()
    private val client = OkHttpClient.Builder().addInterceptor(RetryAfterInterceptor(sleep = { waits += it })).build()

    @Before
    fun start() {
        server = MockWebServer().apply { start() }
    }

    @After
    fun stop() {
        server.shutdown()
    }

    private fun endpoint() = server.url("/").toString()

    private fun refusal(retryAfter: String? = "10") = MockResponse().setResponseCode(429).setBody("429 Too Many Requests")
        .apply { if (retryAfter != null) setHeader("Retry-After", retryAfter) }

    @Test
    fun aRefusedPostIsSentAgainAfterTheNamedWait() {
        server.enqueue(refusal("10"))
        server.enqueue(MockResponse().setBody("""{"protected":"p"}"""))

        val body = postEnvelope(client, endpoint(), """{"envelope":1}""")

        assertEquals("""{"protected":"p"}""", body)
        assertEquals(listOf(10_000L), waits)
        assertEquals(2, server.requestCount)
        // The second copy is the same message, with the DIDComm content type and no charset.
        val first = server.takeRequest()
        val second = server.takeRequest()
        assertEquals("""{"envelope":1}""", second.body.readUtf8())
        assertEquals(first.getHeader("Content-Type"), second.getHeader("Content-Type"))
        assertEquals("application/didcomm-envelope-enc", second.getHeader("Content-Type"))
    }

    @Test
    fun itGivesUpAfterTwoRepeats() {
        repeat(3) { server.enqueue(refusal("1")) }

        try {
            postEnvelope(client, endpoint(), "{}")
            fail("expected HttpStatusException")
        } catch (e: HttpStatusException) {
            assertEquals(429, e.code)
            assertTrue(e.message!!.contains(server.hostName))
        }
        assertEquals(listOf(1_000L, 1_000L), waits)
        assertEquals(3, server.requestCount)
    }

    @Test
    fun aWaitLongerThanTheCapIsNotWaitedFor() {
        server.enqueue(refusal("60"))

        try {
            postEnvelope(client, endpoint(), "{}")
            fail("expected HttpStatusException")
        } catch (e: HttpStatusException) {
            assertEquals(429, e.code)
        }
        assertTrue(waits.isEmpty())
        assertEquals(1, server.requestCount)
    }

    @Test
    fun aMissingHeaderWaitsTheDefault() {
        server.enqueue(refusal(retryAfter = null))
        server.enqueue(MockResponse().setResponseCode(202))

        assertEquals("", postEnvelope(client, endpoint(), "{}"))
        assertEquals(listOf(RetryAfterInterceptor.DEFAULT_WAIT_MILLIS), waits)
    }

    @Test
    fun otherRefusalsAreNotRepeated() {
        // The edge's own 502 has a plain body; upstream parsed it as a DIDComm message.
        server.enqueue(MockResponse().setResponseCode(502).setBody("502 Bad Gateway"))
        // A refusal with an empty body used to count as delivered.
        server.enqueue(MockResponse().setResponseCode(503))

        for (status in listOf(502, 503)) {
            try {
                postEnvelope(client, endpoint(), "{}")
                fail("expected HttpStatusException")
            } catch (e: HttpStatusException) {
                assertEquals(status, e.code)
            }
        }
        assertTrue(waits.isEmpty())
        assertEquals(2, server.requestCount)
    }

    @Test
    fun retryAfterValues() {
        assertEquals(0L, RetryAfterInterceptor.waitMillis("0"))
        assertEquals(10_000L, RetryAfterInterceptor.waitMillis(" 10 "))
        assertNull(RetryAfterInterceptor.waitMillis("11"))
        assertEquals(0L, RetryAfterInterceptor.waitMillis("-5"))
        assertEquals(RetryAfterInterceptor.DEFAULT_WAIT_MILLIS, RetryAfterInterceptor.waitMillis(null))
        assertEquals(RetryAfterInterceptor.DEFAULT_WAIT_MILLIS, RetryAfterInterceptor.waitMillis("Wed, 21 Oct 2026 07:28:00 GMT"))
    }
}
