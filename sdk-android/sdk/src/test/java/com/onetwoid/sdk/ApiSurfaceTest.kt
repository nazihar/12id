package com.onetwoid.sdk

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Customers must never see Aries or framework types (Phase 5 plan S). Reads the API dump kept by the
 * binary-compatibility-validator (`./gradlew :sdk:apiDump`), which `:sdk:apiCheck` keeps in step.
 */
class ApiSurfaceTest {
    @Test
    fun `the public API references no framework or transitive library types`() {
        val dump = File("api/sdk.api")
        assertTrue("missing ${dump.absolutePath}: run ./gradlew :sdk:apiDump", dump.isFile)

        val forbidden = listOf("org/hyperledger", "kotlinx/datetime", "okhttp3", "kotlinx/serialization", "askar_uniffi", "anoncreds_uniffi", "indy_vdr_uniffi", "org/slf4j")
        // org/slf4j/impl classes are the slf4j binding contract (loaded by name), not SDK API: skip their blocks.
        var inBinding = false
        val offending = dump.readLines().filter { line ->
            if (line.startsWith("public")) inBinding = line.contains("org/slf4j/impl/")
            !inBinding && forbidden.any { line.contains(it) }
        }
        assertTrue("framework types in the public API:\n${offending.joinToString("\n")}", offending.isEmpty())
    }
}
