package com.onetwoid.sdk.internal

import askar_uniffi.AskarKeyAlg
import askar_uniffi.LocalKeyFactory
import okio.ByteString.Companion.decodeBase64

/** Ed25519 verification; the SDK uses Askar's, the JVM tests the JDK's. */
internal fun interface Ed25519Verifier {
    fun verify(publicKey: ByteArray, message: ByteArray, signature: ByteArray): Boolean
}

/** Askar already ships in the SDK's native libraries, so the check adds no dependency. */
internal val AskarEd25519 = Ed25519Verifier { publicKey, message, signature ->
    try {
        LocalKeyFactory().fromPublicBytes(AskarKeyAlg.ED25519, publicKey).verifySignature(message, signature, null)
    } catch (e: Exception) {
        false
    }
}

/** A minisign public key: the base64 line of a `.pub` file (`Ed`, an 8-byte key id, the Ed25519 key). */
internal class MinisignPublicKey private constructor(val keyId: ByteArray, val key: ByteArray) {
    companion object {
        /** Accepts the bare base64 line or a whole `.pub` file; `null` when it is not a minisign key. */
        fun parse(text: String): MinisignPublicKey? {
            val line = text.lines().map { it.trim() }.lastOrNull { it.isNotEmpty() } ?: return null
            val bytes = line.decodeBase64()?.toByteArray() ?: return null
            if (bytes.size != 42 || bytes[0] != 'E'.code.toByte() || bytes[1] != 'd'.code.toByte()) return null
            return MinisignPublicKey(bytes.copyOfRange(2, 10), bytes.copyOfRange(10, 42))
        }
    }
}

/**
 * Verifies a minisign signature (https://jedisct1.github.io/minisign/): Ed25519 over the file's
 * BLAKE2b-512 hash (`ED`, what minisign writes) or over the file itself (`Ed`, the legacy format), and
 * a second signature over the first one plus the trusted comment.
 */
internal object Minisign {
    /** True when [signatureFile] is a valid signature of [message] by one of [trustedKeys]. */
    fun verify(message: ByteArray, signatureFile: String, trustedKeys: List<MinisignPublicKey>, ed25519: Ed25519Verifier): Boolean {
        val lines = signatureFile.lines().map { it.trimEnd('\r') }.filter { it.isNotEmpty() }
        if (lines.size != 4 || !lines[2].startsWith(TRUSTED_COMMENT)) return false
        val signature = lines[1].trim().decodeBase64()?.toByteArray() ?: return false
        val globalSignature = lines[3].trim().decodeBase64()?.toByteArray() ?: return false
        if (signature.size != 74 || globalSignature.size != 64 || signature[0] != 'E'.code.toByte()) return false

        val signed = when (signature[1]) {
            'D'.code.toByte() -> Blake2b512.hash(message)
            'd'.code.toByte() -> message
            else -> return false
        }
        val keyId = signature.copyOfRange(2, 10)
        val rawSignature = signature.copyOfRange(10, 74)
        val trustedComment = lines[2].substring(TRUSTED_COMMENT.length).toByteArray(Charsets.UTF_8)
        return trustedKeys.any { trusted ->
            trusted.keyId.contentEquals(keyId) &&
                ed25519.verify(trusted.key, signed, rawSignature) &&
                ed25519.verify(trusted.key, rawSignature + trustedComment, globalSignature)
        }
    }

    private const val TRUSTED_COMMENT = "trusted comment: "
}

/** BLAKE2b with a 64-byte digest and no key (RFC 7693). Android has none before API 28's Conscrypt, and minisign needs it. */
internal object Blake2b512 {
    private const val BLOCK = 128

    private val IV = longArrayOf(
        0x6a09e667f3bcc908uL.toLong(), 0xbb67ae8584caa73buL.toLong(), 0x3c6ef372fe94f82buL.toLong(), 0xa54ff53a5f1d36f1uL.toLong(),
        0x510e527fade682d1uL.toLong(), 0x9b05688c2b3e6c1fuL.toLong(), 0x1f83d9abfb41bd6buL.toLong(), 0x5be0cd19137e2179uL.toLong(),
    )

    private val SIGMA = arrayOf(
        intArrayOf(0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15),
        intArrayOf(14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3),
        intArrayOf(11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4),
        intArrayOf(7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8),
        intArrayOf(9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13),
        intArrayOf(2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9),
        intArrayOf(12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11),
        intArrayOf(13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10),
        intArrayOf(6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5),
        intArrayOf(10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0),
    )

    fun hash(input: ByteArray): ByteArray {
        val h = IV.copyOf()
        h[0] = h[0] xor 0x01010040L // digest length 64, no key, fanout 1, depth 1

        // Every block but the last; the last one is compressed with the final flag even when it is full.
        var offset = 0
        while (input.size - offset > BLOCK) {
            compress(h, input, offset, (offset + BLOCK).toLong(), last = false)
            offset += BLOCK
        }
        val tail = ByteArray(BLOCK)
        input.copyInto(tail, 0, offset, input.size)
        compress(h, tail, 0, input.size.toLong(), last = true)

        val out = ByteArray(64)
        for (i in 0 until 8) for (b in 0 until 8) out[i * 8 + b] = (h[i] ushr (8 * b)).toByte()
        return out
    }

    private fun compress(h: LongArray, block: ByteArray, offset: Int, counter: Long, last: Boolean) {
        val m = LongArray(16) { word ->
            var value = 0L
            for (b in 7 downTo 0) value = (value shl 8) or (block[offset + word * 8 + b].toLong() and 0xff)
            value
        }
        val v = LongArray(16) { if (it < 8) h[it] else IV[it - 8] }
        v[12] = v[12] xor counter // inputs here are far below 2^64 bytes, so the counter's high word stays 0
        if (last) v[14] = v[14].inv()

        for (round in 0 until 12) {
            val s = SIGMA[round % 10]
            mix(v, 0, 4, 8, 12, m[s[0]], m[s[1]])
            mix(v, 1, 5, 9, 13, m[s[2]], m[s[3]])
            mix(v, 2, 6, 10, 14, m[s[4]], m[s[5]])
            mix(v, 3, 7, 11, 15, m[s[6]], m[s[7]])
            mix(v, 0, 5, 10, 15, m[s[8]], m[s[9]])
            mix(v, 1, 6, 11, 12, m[s[10]], m[s[11]])
            mix(v, 2, 7, 8, 13, m[s[12]], m[s[13]])
            mix(v, 3, 4, 9, 14, m[s[14]], m[s[15]])
        }
        for (i in 0 until 8) h[i] = h[i] xor v[i] xor v[i + 8]
    }

    private fun mix(v: LongArray, a: Int, b: Int, c: Int, d: Int, x: Long, y: Long) {
        v[a] = v[a] + v[b] + x
        v[d] = (v[d] xor v[a]).rotateRight(32)
        v[c] = v[c] + v[d]
        v[b] = (v[b] xor v[c]).rotateRight(24)
        v[a] = v[a] + v[b] + y
        v[d] = (v[d] xor v[a]).rotateRight(16)
        v[c] = v[c] + v[d]
        v[b] = (v[b] xor v[c]).rotateRight(63)
    }
}
