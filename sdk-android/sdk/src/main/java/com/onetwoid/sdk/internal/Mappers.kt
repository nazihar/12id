package com.onetwoid.sdk.internal

import com.onetwoid.sdk.Connection
import com.onetwoid.sdk.ConnectionStatus
import com.onetwoid.sdk.Credential
import com.onetwoid.sdk.CredentialCandidate
import com.onetwoid.sdk.OneTwoIdException
import com.onetwoid.sdk.ProofRequest
import com.onetwoid.sdk.ProofRequestOptions
import com.onetwoid.sdk.ProofSelection
import com.onetwoid.sdk.RequestedAttributeGroup
import com.onetwoid.sdk.RequestedPredicate
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.hyperledger.ariesframework.anoncreds.storage.CredentialRecord
import org.hyperledger.ariesframework.connection.models.ConnectionState
import org.hyperledger.ariesframework.connection.repository.ConnectionRecord
import org.hyperledger.ariesframework.proofs.models.IndyCredentialInfo
import org.hyperledger.ariesframework.proofs.models.PredicateType
import org.hyperledger.ariesframework.proofs.models.RequestedCredentials
import org.hyperledger.ariesframework.proofs.models.RetrievedCredentials
import org.hyperledger.ariesframework.proofs.models.ProofRequest as IndyProofRequest

/** Framework records → SDK models. Kept free of Agent calls so JVM tests can cover them. */
internal object Mappers {
    /** The platform's mandatory expiry attribute (4-init §4.7): epoch seconds as a string. */
    const val EXPIRES_AT = "expiresAt"

    private val json = Json { ignoreUnknownKeys = true }

    fun expiresAt(attributes: Map<String, String>): Long? = attributes[EXPIRES_AT]?.trim()?.toLongOrNull()

    /** Raw values of an AnonCreds credential: `{"values": {"name": {"raw": "…", "encoded": "…"}}}`. */
    fun credentialValues(credentialJson: String): Map<String, String> {
        val values = json.parseToJsonElement(credentialJson).jsonObject["values"]?.jsonObject ?: return emptyMap()
        return values.mapValues { (_, value) -> value.jsonObject["raw"]?.jsonPrimitive?.contentOrNull ?: "" }
    }

    /** `cred_def_id` of an Indy credential offer attachment. */
    fun credentialDefinitionIdFromOffer(offerJson: String): String? =
        json.parseToJsonElement(offerJson).jsonObject["cred_def_id"]?.jsonPrimitive?.contentOrNull

    fun credential(record: CredentialRecord): Credential {
        val attributes = credentialValues(record.credential)
        return Credential(
            id = record.credentialId,
            schemaName = record.schemaName,
            schemaVersion = record.schemaVersion,
            credentialDefinitionId = record.credentialDefinitionId,
            attributes = attributes,
            expiresAtEpochSeconds = expiresAt(attributes),
        )
    }

    fun connection(record: ConnectionRecord): Connection = Connection(
        id = record.id,
        label = record.theirLabel,
        status = if (record.state == ConnectionState.Complete) ConnectionStatus.Connected else ConnectionStatus.Pending,
        createdAtEpochSeconds = record.createdAt.epochSeconds,
    )

    fun decodeProofRequest(indyProofRequestJson: String): IndyProofRequest =
        json.decodeFromString(IndyProofRequest.serializer(), indyProofRequestJson)

    fun proofRequest(
        id: String,
        connectionId: String,
        connectionLabel: String?,
        receivedAtEpochSeconds: Long,
        request: IndyProofRequest,
    ): ProofRequest = ProofRequest(
        id = id,
        connectionId = connectionId,
        connectionLabel = connectionLabel,
        name = request.name,
        attributeGroups = request.requestedAttributes.map { (key, info) ->
            RequestedAttributeGroup(key, info.names ?: listOfNotNull(info.name))
        },
        predicates = request.requestedPredicates.map { (key, info) ->
            RequestedPredicate(key, info.name, operator(info.predicateType), info.predicateValue)
        },
        receivedAtEpochSeconds = receivedAtEpochSeconds,
    )

    fun operator(type: PredicateType): String = when (type) {
        PredicateType.LessThan -> "<"
        PredicateType.LessThanOrEqualTo -> "<="
        PredicateType.GreaterThan -> ">"
        PredicateType.GreaterThanOrEqualTo -> ">="
    }

    fun proofRequestOptions(requestId: String, retrieved: RetrievedCredentials): ProofRequestOptions = ProofRequestOptions(
        requestId = requestId,
        attributeGroups = retrieved.requestedAttributes.mapValues { (_, candidates) ->
            candidates.filter { it.revoked != true }.mapNotNull { candidate(it.credentialId, it.credentialInfo) }
        },
        predicates = retrieved.requestedPredicates.mapValues { (_, candidates) ->
            candidates.filter { it.revoked != true }.mapNotNull { candidate(it.credentialId, it.credentialInfo) }
        },
    )

    private fun candidate(credentialId: String, info: IndyCredentialInfo?): CredentialCandidate? =
        info?.let { CredentialCandidate(credentialId, it.credentialDefinitionId, it.attributes) }

    /** The framework's presentation input for [selection]; every group and predicate must be answered by one of its candidates. */
    fun requestedCredentials(retrieved: RetrievedCredentials, selection: ProofSelection): RequestedCredentials {
        val unknown = (selection.attributeGroups.keys - retrieved.requestedAttributes.keys) +
            (selection.predicates.keys - retrieved.requestedPredicates.keys)
        if (unknown.isNotEmpty()) {
            throw OneTwoIdException.InvalidSelection("keys not in the request: ${unknown.sorted()}")
        }
        val attributes = retrieved.requestedAttributes.mapValues { (key, candidates) ->
            val chosen = selection.attributeGroups[key]
                ?: throw OneTwoIdException.InvalidSelection("no credential chosen for group '$key'")
            candidates.firstOrNull { it.credentialId == chosen && it.revoked != true }?.copy(revealed = true)
                ?: throw OneTwoIdException.InvalidSelection("credential $chosen cannot answer group '$key'")
        }
        val predicates = retrieved.requestedPredicates.mapValues { (key, candidates) ->
            val chosen = selection.predicates[key]
                ?: throw OneTwoIdException.InvalidSelection("no credential chosen for predicate '$key'")
            candidates.firstOrNull { it.credentialId == chosen && it.revoked != true }?.copy()
                ?: throw OneTwoIdException.InvalidSelection("credential $chosen cannot answer predicate '$key'")
        }
        return RequestedCredentials(requestedAttributes = attributes.toMutableMap(), requestedPredicates = predicates.toMutableMap())
    }
}
