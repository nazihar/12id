package com.onetwoid.sdk.internal

import com.onetwoid.sdk.OneTwoIdException
import com.onetwoid.sdk.ProofSelection
import com.onetwoid.sdk.RequestedAttributeGroup
import com.onetwoid.sdk.RequestedPredicate
import org.hyperledger.ariesframework.proofs.models.IndyCredentialInfo
import org.hyperledger.ariesframework.proofs.models.RetrievedCredentials
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.hyperledger.ariesframework.proofs.models.RequestedAttribute as IndyRequestedAttribute
import org.hyperledger.ariesframework.proofs.models.RequestedPredicate as IndyRequestedPredicate

class MappersTest {
    private val credDef = "JLNRNkS44QeUoJnwt4gKQh:3:CL:61:default"

    private fun info(referent: String, attrs: Map<String, String> = mapOf("name" to "Ada")) =
        IndyCredentialInfo(referent, attrs, "JLNRNkS44QeUoJnwt4gKQh:2:badge:1.0", credDef)

    private fun retrieved(): RetrievedCredentials = RetrievedCredentials().apply {
        requestedAttributes["employee"] = listOf(
            IndyRequestedAttribute("cred-1", null, true, info("cred-1")),
            IndyRequestedAttribute("cred-revoked", null, true, info("cred-revoked"), revoked = true),
        )
        requestedPredicates["expiresAt"] = listOf(IndyRequestedPredicate("cred-1", null, info("cred-1")))
    }

    @Test
    fun `expiresAt is read as epoch seconds and ignored when not numeric`() {
        assertEquals(1893456000L, Mappers.expiresAt(mapOf("expiresAt" to " 1893456000 ")))
        assertNull(Mappers.expiresAt(mapOf("expiresAt" to "2030-01-01")))
        assertNull(Mappers.expiresAt(emptyMap()))
    }

    @Test
    fun `credential values are the raw values`() {
        val json = """{"schema_id":"s","values":{"name":{"raw":"Ada","encoded":"123"},"expiresAt":{"raw":"1893456000","encoded":"1893456000"}}}"""
        assertEquals(mapOf("name" to "Ada", "expiresAt" to "1893456000"), Mappers.credentialValues(json))
    }

    @Test
    fun `the credential definition id comes from the offer attachment`() {
        assertEquals(credDef, Mappers.credentialDefinitionIdFromOffer("""{"schema_id":"s","cred_def_id":"$credDef","nonce":"1"}"""))
    }

    @Test
    fun `proof request groups and predicates are exposed without Indy types`() {
        val request = Mappers.decodeProofRequest(
            """
            {"name":"smoke-platform-android","version":"1.0","nonce":"42",
             "requested_attributes":{"employee":{"names":["name","department"],"restrictions":[{"cred_def_id":"$credDef"}]}},
             "requested_predicates":{"expiresAt":{"name":"expiresAt","p_type":">=","p_value":1789000000,"restrictions":[{"cred_def_id":"$credDef"}]}}}
            """.trimIndent(),
        )

        val mapped = Mappers.proofRequest("proof-1", "conn-1", "Acme", 1L, request)

        assertEquals("smoke-platform-android", mapped.name)
        assertEquals(listOf(RequestedAttributeGroup("employee", listOf("name", "department"))), mapped.attributeGroups)
        assertEquals(listOf(RequestedPredicate("expiresAt", "expiresAt", ">=", 1789000000)), mapped.predicates)
    }

    @Test
    fun `revoked candidates are not offered`() {
        val options = Mappers.proofRequestOptions("proof-1", retrieved())

        assertEquals(listOf("cred-1"), options.attributeGroups.getValue("employee").map { it.credentialId })
        assertTrue(options.isSatisfiable)
        assertEquals(ProofSelection(mapOf("employee" to "cred-1"), mapOf("expiresAt" to "cred-1")), options.defaultSelection())
    }

    @Test
    fun `a request with an unanswerable group is not satisfiable`() {
        val options = Mappers.proofRequestOptions(
            "proof-1",
            RetrievedCredentials().apply { requestedAttributes["employee"] = emptyList() },
        )

        assertFalse(options.isSatisfiable)
        assertNull(options.defaultSelection())
    }

    @Test
    fun `a valid selection becomes revealed requested credentials`() {
        val requested = Mappers.requestedCredentials(retrieved(), ProofSelection(mapOf("employee" to "cred-1"), mapOf("expiresAt" to "cred-1")))

        assertEquals("cred-1", requested.requestedAttributes.getValue("employee").credentialId)
        assertTrue(requested.requestedAttributes.getValue("employee").revealed)
        assertEquals("cred-1", requested.requestedPredicates.getValue("expiresAt").credentialId)
    }

    @Test
    fun `selections that do not cover the request are refused`() {
        val cases = listOf(
            ProofSelection(emptyMap(), mapOf("expiresAt" to "cred-1")),
            ProofSelection(mapOf("employee" to "cred-1"), emptyMap()),
            ProofSelection(mapOf("employee" to "cred-unknown"), mapOf("expiresAt" to "cred-1")),
            ProofSelection(mapOf("employee" to "cred-revoked"), mapOf("expiresAt" to "cred-1")),
            ProofSelection(mapOf("employee" to "cred-1", "other" to "cred-1"), mapOf("expiresAt" to "cred-1")),
        )
        for (selection in cases) {
            try {
                Mappers.requestedCredentials(retrieved(), selection)
                fail("expected InvalidSelection for $selection")
            } catch (e: OneTwoIdException.InvalidSelection) {
                // expected
            }
        }
    }
}
