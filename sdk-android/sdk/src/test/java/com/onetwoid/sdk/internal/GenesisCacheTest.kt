package com.onetwoid.sdk.internal

import com.onetwoid.sdk.OneTwoIdException
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class GenesisCacheTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private lateinit var server: MockWebServer
    private val genesis = """{"reqSignature":{},"txn":{"data":{"data":{"alias":"Node1"}}}}""".toByteArray()
    private val sha = GenesisCache.sha256(genesis)

    @Before
    fun start() {
        server = MockWebServer().apply { start() }
    }

    @After
    fun stop() {
        server.shutdown()
    }

    private fun ledgerResponse(sha256: String) = MockResponse().setBody(
        """{"indyNamespace":"12id","genesis":{"url":"${server.url("/v1/pool_transactions_genesis")}","sha256":"$sha256"}}""",
    )

    private fun cache(dir: File = File(tmp.root, "genesis")) =
        GenesisCache(dir, PlatformClient(server.url("/").toString(), { "t" }))

    @Test
    fun `downloads, verifies and caches the genesis by checksum`() = runBlocking {
        server.enqueue(ledgerResponse(sha))
        server.enqueue(MockResponse().setBody(okio.Buffer().write(genesis)))

        val resolved = cache().resolve(knownSha256 = null)

        assertEquals(sha, resolved.sha256)
        assertEquals("genesis-$sha.txn", resolved.file.name)
        assertArrayEquals(genesis, resolved.file.readBytes())
    }

    @Test
    fun `a cached file matching the platform checksum is not downloaded again`() = runBlocking {
        val dir = File(tmp.root, "genesis").apply { mkdirs() }
        File(dir, "genesis-$sha.txn").writeBytes(genesis)
        server.enqueue(ledgerResponse(sha))

        val resolved = cache(dir).resolve(knownSha256 = sha)

        assertEquals(sha, resolved.sha256)
        assertEquals(1, server.requestCount)
    }

    @Test
    fun `a checksum mismatch is refused and nothing is cached`() = runBlocking {
        server.enqueue(ledgerResponse("0".repeat(64)))
        server.enqueue(MockResponse().setBody(okio.Buffer().write(genesis)))
        val dir = File(tmp.root, "genesis")

        try {
            cache(dir).resolve(knownSha256 = null)
            fail("expected LedgerUnavailable")
        } catch (e: OneTwoIdException.LedgerUnavailable) {
            assertEquals(0, dir.listFiles()?.count { it.name.endsWith(".txn") } ?: 0)
        }
    }

    @Test
    fun `a rotated genesis replaces the old cached file`() = runBlocking {
        val dir = File(tmp.root, "genesis").apply { mkdirs() }
        val old = File(dir, "genesis-${"1".repeat(64)}.txn").apply { writeText("old") }
        server.enqueue(ledgerResponse(sha))
        server.enqueue(MockResponse().setBody(okio.Buffer().write(genesis)))

        cache(dir).resolve(knownSha256 = "1".repeat(64))

        assertEquals(false, old.exists())
    }

    @Test
    fun `offline, the previously verified file is used`() = runBlocking {
        val dir = File(tmp.root, "genesis").apply { mkdirs() }
        File(dir, "genesis-$sha.txn").writeBytes(genesis)
        server.shutdown()

        val resolved = cache(dir).resolve(knownSha256 = sha)

        assertEquals(sha, resolved.sha256)
    }

    @Test
    fun `offline without a cached file reports LedgerUnavailable`() = runBlocking {
        server.shutdown()

        try {
            cache().resolve(knownSha256 = null)
            fail("expected LedgerUnavailable")
        } catch (e: OneTwoIdException.LedgerUnavailable) {
            // expected
        }
    }
}
