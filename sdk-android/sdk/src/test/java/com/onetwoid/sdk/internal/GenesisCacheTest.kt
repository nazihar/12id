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
    private val signer = TestMinisign()
    private val signature = signer.sign(genesis)

    @Before
    fun start() {
        server = MockWebServer().apply { start() }
    }

    @After
    fun stop() {
        server.shutdown()
    }

    private fun ledgerResponse(sha256: String, signed: Boolean = true): MockResponse {
        val signatureUrl = if (signed) ""","signatureUrl":"${server.url("/v1/pool_transactions_genesis.minisig")}"""" else ""
        return MockResponse().setBody(
            """{"indyNamespace":"12id","genesis":{"url":"${server.url("/v1/pool_transactions_genesis")}","sha256":"$sha256"$signatureUrl}}""",
        )
    }

    private fun cache(dir: File = File(tmp.root, "genesis"), trusted: List<String> = listOf(signer.publicKey)) =
        GenesisCache(dir, PlatformClient(server.url("/").toString(), { "t" }), trusted, JdkEd25519)

    /** A genesis this SDK already verified: the file and its signature. */
    private fun cachedGenesis(signatureFile: String? = signature) = File(tmp.root, "genesis").apply {
        mkdirs()
        File(this, "genesis-$sha.txn").writeBytes(genesis)
        if (signatureFile != null) File(this, "genesis-$sha.txn.minisig").writeText(signatureFile)
    }

    private fun txnFiles(dir: File) = dir.listFiles()?.count { it.name.endsWith(".txn") } ?: 0

    @Test
    fun `downloads, verifies and caches the genesis with its signature`() = runBlocking {
        server.enqueue(ledgerResponse(sha))
        server.enqueue(MockResponse().setBody(okio.Buffer().write(genesis)))
        server.enqueue(MockResponse().setBody(signature))

        val resolved = cache().resolve(knownSha256 = null)

        assertEquals(sha, resolved.sha256)
        assertEquals("genesis-$sha.txn", resolved.file.name)
        assertArrayEquals(genesis, resolved.file.readBytes())
        assertEquals(signature, File(resolved.file.parentFile, "genesis-$sha.txn.minisig").readText())
    }

    @Test
    fun `a genesis signed by a key the app does not trust is refused and nothing is cached`() = runBlocking {
        // The platform is the attacker here: the checksum matches and the signature is valid, by its own key.
        val attacker = TestMinisign(keyId = byteArrayOf(8, 7, 6, 5, 4, 3, 2, 1))
        server.enqueue(ledgerResponse(sha))
        server.enqueue(MockResponse().setBody(okio.Buffer().write(genesis)))
        server.enqueue(MockResponse().setBody(attacker.sign(genesis)))
        val dir = File(tmp.root, "genesis")

        try {
            cache(dir).resolve(knownSha256 = null)
            fail("expected LedgerUnavailable")
        } catch (e: OneTwoIdException.LedgerUnavailable) {
            assertEquals(0, txnFiles(dir))
        }
    }

    @Test
    fun `a genesis without a published signature is refused`() = runBlocking {
        server.enqueue(ledgerResponse(sha, signed = false))
        server.enqueue(MockResponse().setBody(okio.Buffer().write(genesis)))
        val dir = File(tmp.root, "genesis")

        try {
            cache(dir).resolve(knownSha256 = null)
            fail("expected LedgerUnavailable")
        } catch (e: OneTwoIdException.LedgerUnavailable) {
            assertEquals(0, txnFiles(dir))
        }
    }

    @Test
    fun `a file cached before signatures were checked is downloaded and verified again`() = runBlocking {
        val dir = cachedGenesis(signatureFile = null)
        server.enqueue(ledgerResponse(sha))
        server.enqueue(MockResponse().setBody(okio.Buffer().write(genesis)))
        server.enqueue(MockResponse().setBody(signature))

        cache(dir).resolve(knownSha256 = sha)

        assertEquals(3, server.requestCount)
        assertEquals(signature, File(dir, "genesis-$sha.txn.minisig").readText())
    }

    @Test
    fun `offline, a cached file whose signature is not from a trusted key is not used`() = runBlocking {
        val dir = cachedGenesis(signatureFile = TestMinisign(keyId = byteArrayOf(8, 7, 6, 5, 4, 3, 2, 1)).sign(genesis))
        server.shutdown()

        try {
            cache(dir).resolve(knownSha256 = sha)
            fail("expected LedgerUnavailable")
        } catch (e: OneTwoIdException.LedgerUnavailable) {
            // expected
        }
    }

    @Test
    fun `a key that is not a minisign public key is a configuration error`() {
        try {
            cache(trusted = listOf("not a key"))
            fail("expected InvalidConfiguration")
        } catch (e: OneTwoIdException.InvalidConfiguration) {
            // expected
        }
    }

    @Test
    fun `a cached file matching the platform checksum is not downloaded again`() = runBlocking {
        val dir = cachedGenesis()
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
            assertEquals(0, txnFiles(dir))
        }
    }

    @Test
    fun `a rotated genesis replaces the old cached file`() = runBlocking {
        val dir = File(tmp.root, "genesis").apply { mkdirs() }
        val old = File(dir, "genesis-${"1".repeat(64)}.txn").apply { writeText("old") }
        val oldSignature = File(dir, "genesis-${"1".repeat(64)}.txn.minisig").apply { writeText("old") }
        server.enqueue(ledgerResponse(sha))
        server.enqueue(MockResponse().setBody(okio.Buffer().write(genesis)))
        server.enqueue(MockResponse().setBody(signature))

        cache(dir).resolve(knownSha256 = "1".repeat(64))

        assertEquals(false, old.exists())
        assertEquals(false, oldSignature.exists())
        assertEquals(true, File(dir, "genesis-$sha.txn.minisig").exists())
    }

    @Test
    fun `offline, the previously verified file is used`() = runBlocking {
        val dir = cachedGenesis()
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
