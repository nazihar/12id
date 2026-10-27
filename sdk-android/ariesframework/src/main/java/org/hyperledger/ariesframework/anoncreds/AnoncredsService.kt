package org.hyperledger.ariesframework.anoncreds

import askar_uniffi.AskarEntryOperation
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.hyperledger.ariesframework.agent.Agent
import org.hyperledger.ariesframework.proofs.models.AttributeFilter
import org.hyperledger.ariesframework.proofs.models.IndyCredentialInfo
import org.hyperledger.ariesframework.proofs.models.ProofRequest
import org.slf4j.LoggerFactory

class AnoncredsService(val agent: Agent) {
    private val logger = LoggerFactory.getLogger(AnoncredsService::class.java)
    private val secretCategory = "link-secret-category"

    suspend fun createLinkSecret(): String {
        val linkSecretId = java.util.UUID.randomUUID().toString()
        val linkSecret = anoncreds_uniffi.createLinkSecret()
        agent.wallet.session!!.update(AskarEntryOperation.INSERT, secretCategory, linkSecretId, linkSecret.toByteArray(), null, null)
        return linkSecretId
    }

    suspend fun getLinkSecret(id: String): String {
        val linkSecret = agent.wallet.session!!.fetch(secretCategory, id, false)
            ?: throw Exception("Link secret not found for id $id")
        return String(linkSecret.value())
    }

    suspend fun getCredentialsForProofRequest(proofRequest: ProofRequest, referent: String): List<IndyCredentialInfo> {
        val requestedAttribute = proofRequest.requestedAttributes[referent] ?: proofRequest.requestedPredicates[referent]?.asProofAttributeInfo()
            ?: throw Exception("Referent not found in proof request")
        if (requestedAttribute.names == null && requestedAttribute.name == null) {
            throw Exception("Proof request attribute must have either name or names")
        }
        if (requestedAttribute.names != null && requestedAttribute.name != null) {
            throw Exception("Proof request attribute cannot have both name and names")
        }
        val attributes = requestedAttribute.names ?: listOf(requestedAttribute.name!!)
        val credentials = agent.credentialRepository.findByQuery(credentialQuery(attributes, requestedAttribute.restrictions).toString())
        return credentials.map { credentialRecord ->
            IndyCredentialInfo(
                credentialRecord.credentialId,
                emptyMap(), // We don't use attrs.
                credentialRecord.schemaId,
                credentialRecord.credentialDefinitionId,
                credentialRecord.revocationRegistryId,
                credentialRecord.credentialRevocationId,
            )
        }
    }

    companion object {
        /**
         * The wallet query for the credentials that can answer one requested attribute or predicate.
         *
         * 12id fork change (F11): AnonCreds restrictions are alternatives (any one of them may match), and the
         * fields of one restriction must all hold. Upstream wrote every restriction into one tag map, so each
         * overwrote the one before it and only the last counted: a request accepting several credential
         * definitions (a template over every version of a schema) matched only credentials of the last one.
         * Now each restriction is one clause and several are joined with Askar's `$or`.
         */
        internal fun credentialQuery(attributes: List<String>, restrictions: List<AttributeFilter>?): JsonObject {
            val clauses = restrictions.orEmpty().map(::restrictionTags).filter { it.isNotEmpty() }
            return buildJsonObject {
                for (attribute in attributes) {
                    put("attr::$attribute::marker", "1")
                }
                when (clauses.size) {
                    0 -> Unit
                    1 -> clauses.single().forEach { (key, value) -> put(key, value) }
                    else -> put("\$or", JsonArray(clauses.map { clause -> JsonObject(clause.mapValues { JsonPrimitive(it.value) }) }))
                }
            }
        }

        private fun restrictionTags(restriction: AttributeFilter): Map<String, String> {
            val tags = mutableMapOf<String, String>()
            restriction.schemaId?.let { tags["schemaId"] = it }
            restriction.schemaName?.let { tags["schemaName"] = it }
            restriction.schemaVersion?.let { tags["schemaVersion"] = it }
            restriction.schemaIssuerDid?.let { tags["schemaIssuerDid"] = it }
            restriction.issuerDid?.let { tags["issuerDid"] = it }
            restriction.credentialDefinitionId?.let { tags["credentialDefinitionId"] = it }
            return tags
        }
    }
}
