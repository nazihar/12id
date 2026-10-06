package com.onetwoid.sdk.internal

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MinisignTest {
    private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }

    /** `(i * 7 + 3) & 0xff` per byte; the digests come from Node's `createHash('blake2b512')`. */
    private fun pattern(size: Int) = ByteArray(size) { ((it * 7 + 3) and 0xff).toByte() }

    private fun resource(name: String) = javaClass.getResourceAsStream("/genesis/$name")!!.readBytes()

    // Staging's genesis v2 and its signature as published on 2026-10-04, and staging's public key.
    private val stagingGenesis = resource("staging-v2.txn")
    private val stagingSignature = String(resource("staging-v2.txn.minisig"))
    private val stagingKey = MinisignPublicKey.parse("RWQcw6JLDHFMuOVVvjNl887FZ2kqxSzBxotXAiQmvIYZCqb+10Dvu/s9")!!

    @Test
    fun `BLAKE2b-512 matches the RFC 7693 vectors`() {
        assertEquals(
            "786a02f742015903c6c6fd852552d272912f4740e15847618a86e217f71f5419d25e1031afee585313896444934eb04b903a685b1448b755d56f701afe9be2ce",
            hex(Blake2b512.hash(ByteArray(0))),
        )
        assertEquals(
            "ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923",
            hex(Blake2b512.hash("abc".toByteArray())),
        )
    }

    @Test
    fun `BLAKE2b-512 is right on both sides of every block boundary`() {
        val expected = mapOf(
            127 to "71546bbf9110ad184cc60f2eb120fcfd9b4dbbca7a7f1270045b8a23a6a4f4330f65c1f030dd2f5fabc6c57617242c37cf427bd90407fac5b9deffd3ae888c39",
            128 to "2d9e329f42afa3601d646692b81c13e87fcaff5bf15972e9813d7373cb6d181f9599f4d513d4af4fd6ebd37497aceb29aba5ee23ed764d8510b552bd088814fb",
            129 to "47889df9eb4d717afc5019df5c6a83df00a0b8677395e078cd5778ace0f338a618e68b7d9afb065d9e6a01ccd31d109447e7fae771c3ee3e105709194122ba2b",
            255 to "1a5199ac66a00e8a87ad1c7fbad30b33137dd8312bf6d98602dacf8f40ea2cb623a7fbc63e5a6bfa434d337ae7da5ca1a52502a215a3fe0297a151be85d88789",
            256 to "91019c558584980249ca43eceed27e19f1c3c24161b93eed1eee2a6a774f60bf8a81b43750870bee1698feac9c5336ae4d5c842e7ead159bf3916387e8ded9ae",
            257 to "9f1975efca45e7b74b020975d4d2c22802906ed8bfefca51ac497bd23147fc8f303890d8e5471ab6caaa02362e831a9e8d3435279912ccd4842c7806b096c348",
            1000 to "4bdd2c9cf31d797a81d245c989ffb7515143ca345c66f73087dd5c58bf642bf083ba16894eab79e3b08d5126404d833e7510271b50be36a7b7cbbb46f5c89fac",
        )
        for ((size, digest) in expected) assertEquals("size $size", digest, hex(Blake2b512.hash(pattern(size))))
    }

    @Test
    fun `the signature minisign wrote for staging's genesis verifies`() {
        assertTrue(Minisign.verify(stagingGenesis, stagingSignature, listOf(stagingKey), JdkEd25519))
    }

    @Test
    fun `a changed genesis file is refused`() {
        val tampered = stagingGenesis.copyOf().also { it[100] = (it[100] + 1).toByte() }
        assertFalse(Minisign.verify(tampered, stagingSignature, listOf(stagingKey), JdkEd25519))
    }

    @Test
    fun `a changed trusted comment is refused`() {
        val tampered = stagingSignature.replace("12id genesis v2", "12id genesis v3")
        assertFalse(Minisign.verify(stagingGenesis, tampered, listOf(stagingKey), JdkEd25519))
    }

    @Test
    fun `a signature from a key that is not trusted is refused`() {
        val other = MinisignPublicKey.parse(TestMinisign().publicKey)!!
        assertFalse(Minisign.verify(stagingGenesis, stagingSignature, listOf(other), JdkEd25519))
        assertFalse(Minisign.verify(stagingGenesis, stagingSignature, emptyList(), JdkEd25519))
    }

    @Test
    fun `another key that claims the trusted key's id is refused`() {
        val trusted = TestMinisign()
        val impostor = TestMinisign() // same default key id, different key
        val message = "genesis".toByteArray()
        assertTrue(Minisign.verify(message, trusted.sign(message), listOf(MinisignPublicKey.parse(trusted.publicKey)!!), JdkEd25519))
        assertFalse(Minisign.verify(message, impostor.sign(message), listOf(MinisignPublicKey.parse(trusted.publicKey)!!), JdkEd25519))
    }

    @Test
    fun `any one of several trusted keys is enough`() {
        val backup = TestMinisign(keyId = byteArrayOf(9, 9, 9, 9, 9, 9, 9, 9))
        val message = "genesis".toByteArray()
        val keys = listOf(stagingKey, MinisignPublicKey.parse(backup.publicKey)!!)
        assertTrue(Minisign.verify(message, backup.sign(message), keys, JdkEd25519))
        assertTrue(Minisign.verify(stagingGenesis, stagingSignature, keys, JdkEd25519))
    }

    @Test
    fun `the legacy format signs the file itself`() {
        val signer = TestMinisign()
        val message = pattern(300)
        val keys = listOf(MinisignPublicKey.parse(signer.publicKey)!!)
        assertTrue(Minisign.verify(message, signer.sign(message, prehashed = false), keys, JdkEd25519))
        assertFalse(Minisign.verify(pattern(301), signer.sign(message, prehashed = false), keys, JdkEd25519))
    }

    @Test
    fun `a malformed signature file is refused, not thrown on`() {
        val keys = listOf(stagingKey)
        val lines = stagingSignature.trim().lines()
        val malformed = listOf(
            "",
            "not a signature",
            lines.take(2).joinToString("\n"),
            lines.take(3).joinToString("\n"),
            (lines.take(3) + "!!!not base64!!!").joinToString("\n"),
            listOf(lines[0], "AAAA", lines[2], lines[3]).joinToString("\n"),
            listOf(lines[0], lines[1], "untrusted comment: x", lines[3]).joinToString("\n"),
        )
        for (file in malformed) assertFalse("accepted: $file", Minisign.verify(stagingGenesis, file, keys, JdkEd25519))
    }

    @Test
    fun `a public key is the base64 line or the whole pub file`() {
        val line = "RWQcw6JLDHFMuOVVvjNl887FZ2kqxSzBxotXAiQmvIYZCqb+10Dvu/s9"
        assertNotNull(MinisignPublicKey.parse(line))
        assertNotNull(MinisignPublicKey.parse("untrusted comment: minisign public key B84C710C4BA2C31C\n$line\n"))
        for (bad in listOf("", "RWQcw6JL", "not base64 at all", line.replaceFirst("RW", "QU"))) {
            assertNull("accepted: $bad", MinisignPublicKey.parse(bad))
        }
    }
}
