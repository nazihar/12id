package org.hyperledger.ariesframework.anoncreds

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import org.hyperledger.ariesframework.proofs.models.AttributeFilter
import org.junit.Assert.assertEquals
import org.junit.Test

/** Fork change F11: proof-request restrictions are alternatives, not one merged filter. */
class CredentialQueryTest {
    private fun query(json: String) = Json.parseToJsonElement(json) as JsonObject

    @Test
    fun severalCredentialDefinitionsAreAlternatives() {
        val result = AnoncredsService.credentialQuery(
            listOf("name"),
            listOf(AttributeFilter(credentialDefinitionId = "A:3:CL:1:default"), AttributeFilter(credentialDefinitionId = "A:3:CL:2:default")),
        )
        // Upstream produced {"attr::name::marker":"1","credentialDefinitionId":"A:3:CL:2:default"}: the first was lost.
        assertEquals(
            query("""{"attr::name::marker":"1","${'$'}or":[{"credentialDefinitionId":"A:3:CL:1:default"},{"credentialDefinitionId":"A:3:CL:2:default"}]}"""),
            result,
        )
    }

    @Test
    fun oneRestrictionStaysAFlatQuery() {
        val result = AnoncredsService.credentialQuery(listOf("name"), listOf(AttributeFilter(credentialDefinitionId = "A:3:CL:1:default")))
        assertEquals(query("""{"attr::name::marker":"1","credentialDefinitionId":"A:3:CL:1:default"}"""), result)
    }

    @Test
    fun theFieldsOfOneRestrictionAllHold() {
        val result = AnoncredsService.credentialQuery(
            listOf("name", "department"),
            listOf(
                AttributeFilter(schemaName = "employee", issuerDid = "A"),
                AttributeFilter(credentialDefinitionId = "B:3:CL:9:default"),
            ),
        )
        assertEquals(
            query(
                """{"attr::name::marker":"1","attr::department::marker":"1",
                   "${'$'}or":[{"schemaName":"employee","issuerDid":"A"},{"credentialDefinitionId":"B:3:CL:9:default"}]}""",
            ),
            result,
        )
    }

    @Test
    fun noOrEmptyRestrictionsMatchOnTheAttributesOnly() {
        val expected = query("""{"attr::name::marker":"1"}""")
        assertEquals(expected, AnoncredsService.credentialQuery(listOf("name"), null))
        assertEquals(expected, AnoncredsService.credentialQuery(listOf("name"), emptyList()))
        assertEquals(expected, AnoncredsService.credentialQuery(listOf("name"), listOf(AttributeFilter())))
    }
}
