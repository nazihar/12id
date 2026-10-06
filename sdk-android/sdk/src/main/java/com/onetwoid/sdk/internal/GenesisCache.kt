package com.onetwoid.sdk.internal

import com.onetwoid.sdk.OneTwoIdException
import java.io.File
import java.security.MessageDigest

/** The genesis file the framework opens, and the checksum it was verified against. */
internal data class ResolvedGenesis(val file: File, val sha256: String)

/**
 * Fetches the genesis file named by `GET /v1/ledger` and caches it as `genesis-<sha256>.txn` with its
 * minisign signature next to it (4-init §4.3, trap 1: never compiled into the app). When the platform
 * is unreachable, the cached file is used.
 *
 * The file is trusted only when its signature verifies against one of [trustedKeys], which come from
 * the app's configuration, not from the platform (review M15). The checksum, the signature URL and the
 * key in `/v1/ledger` are hints: they arrive over the same connection as the file, so a compromised
 * platform could replace all of them together. The signature is checked on every start, cached file
 * included, so a file cached before this check existed is downloaded again.
 */
internal class GenesisCache(
    private val directory: File,
    private val client: PlatformClient,
    trustedKeys: List<String>,
    private val ed25519: Ed25519Verifier = AskarEd25519,
) {
    private val trustedKeys = trustedKeys.map {
        MinisignPublicKey.parse(it) ?: throw OneTwoIdException.InvalidConfiguration("genesisPublicKeys: not a minisign public key: $it")
    }

    suspend fun resolve(knownSha256: String?): ResolvedGenesis {
        val config = try {
            client.ledgerConfig()
        } catch (e: OneTwoIdException.NetworkUnavailable) {
            return cached(knownSha256) ?: throw OneTwoIdException.LedgerUnavailable("no cached genesis and the platform is unreachable", e)
        }

        val expected = config.genesis.sha256.lowercase()
        cached(expected)?.let { return it }

        val bytes = client.download(config.genesis.url)
        val actual = sha256(bytes)
        if (actual != expected) {
            throw OneTwoIdException.LedgerUnavailable("genesis checksum mismatch (expected $expected, got $actual)")
        }
        val signatureUrl = config.genesis.signatureUrl
            ?: throw OneTwoIdException.LedgerUnavailable("the platform publishes no genesis signature")
        val signature = client.download(signatureUrl)
        if (!signedByTrustedKey(bytes, signature)) {
            throw OneTwoIdException.LedgerUnavailable("the genesis signature is not from a trusted key")
        }

        directory.mkdirs()
        val target = fileFor(expected)
        write(signatureFileFor(expected), signature)
        write(target, bytes)
        // Keep only the genesis in use; a rotated genesis leaves the old files behind otherwise.
        directory.listFiles { f -> f.name.startsWith(PREFIX) && !f.name.startsWith(target.name) }?.forEach { it.delete() }
        return ResolvedGenesis(target, expected)
    }

    /** The cached file for [sha256], only if its content still matches and its stored signature verifies. */
    private fun cached(sha256: String?): ResolvedGenesis? {
        if (sha256 == null) return null
        val file = fileFor(sha256)
        val signature = signatureFileFor(sha256)
        if (!file.isFile || !signature.isFile) return null
        val bytes = file.readBytes()
        if (sha256(bytes) != sha256 || !signedByTrustedKey(bytes, signature.readBytes())) return null
        return ResolvedGenesis(file, sha256)
    }

    private fun signedByTrustedKey(genesis: ByteArray, signature: ByteArray) =
        Minisign.verify(genesis, String(signature, Charsets.UTF_8), trustedKeys, ed25519)

    private fun write(target: File, bytes: ByteArray) {
        val tmp = File(directory, "${target.name}.tmp")
        tmp.writeBytes(bytes)
        if (!tmp.renameTo(target)) {
            target.delete()
            check(tmp.renameTo(target)) { "cannot write ${target.absolutePath}" }
        }
    }

    private fun fileFor(sha256: String) = File(directory, "$PREFIX$sha256.txn")

    private fun signatureFileFor(sha256: String) = File(directory, "$PREFIX$sha256.txn.minisig")

    companion object {
        private const val PREFIX = "genesis-"

        fun sha256(bytes: ByteArray): String =
            MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    }
}
