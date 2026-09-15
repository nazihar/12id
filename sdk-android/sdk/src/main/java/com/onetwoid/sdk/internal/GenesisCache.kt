package com.onetwoid.sdk.internal

import com.onetwoid.sdk.OneTwoIdException
import java.io.File
import java.security.MessageDigest

/** The genesis file the framework opens, and the checksum it was verified against. */
internal data class ResolvedGenesis(val file: File, val sha256: String)

/**
 * Fetches the genesis file named by `GET /v1/ledger`, verifies its sha256 and caches it as
 * `genesis-<sha256>.txn` (4-init §4.3, trap 1: never compiled into the app). When the platform is
 * unreachable, the previously verified file is used.
 */
internal class GenesisCache(private val directory: File, private val client: PlatformClient) {

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
        directory.mkdirs()
        val target = fileFor(expected)
        val tmp = File(directory, "${target.name}.tmp")
        tmp.writeBytes(bytes)
        if (!tmp.renameTo(target)) {
            target.delete()
            check(tmp.renameTo(target)) { "cannot write ${target.absolutePath}" }
        }
        // Keep only the genesis in use; a rotated genesis leaves the old file behind otherwise.
        directory.listFiles { f -> f.name.startsWith(PREFIX) && f.name != target.name }?.forEach { it.delete() }
        return ResolvedGenesis(target, expected)
    }

    /** The cached file for [sha256], only if its content still matches. */
    private fun cached(sha256: String?): ResolvedGenesis? {
        if (sha256 == null) return null
        val file = fileFor(sha256)
        if (!file.isFile || sha256(file.readBytes()) != sha256) return null
        return ResolvedGenesis(file, sha256)
    }

    private fun fileFor(sha256: String) = File(directory, "$PREFIX$sha256.txn")

    companion object {
        private const val PREFIX = "genesis-"

        fun sha256(bytes: ByteArray): String =
            MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    }
}
