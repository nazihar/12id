package com.onetwoid.sdk.internal

import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import java.util.Base64

private val X509_ED25519_PREFIX = byteArrayOf(0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00)

/** The JDK's Ed25519 (15+): the JVM tests cannot load Askar's Android libraries. */
internal val JdkEd25519 = Ed25519Verifier { publicKey, message, signature ->
    try {
        val key = KeyFactory.getInstance("Ed25519").generatePublic(X509EncodedKeySpec(X509_ED25519_PREFIX + publicKey))
        Signature.getInstance("Ed25519").run {
            initVerify(key)
            update(message)
            verify(signature)
        }
    } catch (e: Exception) {
        false
    }
}

/** A minisign key pair for tests: signs the way `minisign -S` does. */
internal class TestMinisign(private val keyId: ByteArray = byteArrayOf(1, 2, 3, 4, 5, 6, 7, 8)) {
    private val pair = KeyPairGenerator.getInstance("Ed25519").generateKeyPair()
    private val rawPublicKey = pair.public.encoded.takeLast(32).toByteArray()

    /** The base64 line of the `.pub` file. */
    val publicKey: String = Base64.getEncoder().encodeToString("Ed".toByteArray() + keyId + rawPublicKey)

    fun sign(message: ByteArray, trustedComment: String = "test genesis", prehashed: Boolean = true): String {
        val signature = ed25519(if (prehashed) Blake2b512.hash(message) else message)
        val global = ed25519(signature + trustedComment.toByteArray())
        val line = Base64.getEncoder().encodeToString((if (prehashed) "ED" else "Ed").toByteArray() + keyId + signature)
        return "untrusted comment: signature from minisign secret key\n$line\n" +
            "trusted comment: $trustedComment\n${Base64.getEncoder().encodeToString(global)}\n"
    }

    private fun ed25519(data: ByteArray): ByteArray = Signature.getInstance("Ed25519").run {
        initSign(pair.private)
        update(data)
        sign()
    }
}
