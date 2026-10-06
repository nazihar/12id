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
    /** The platform's mandatory expiry attribute (4-init §4.7): the expiry date as `YYYYMMDD`, UTC. */
    const val EXPIRES_ON = "expiresOn"

    private val json = Json { ignoreUnknownKeys = true }

    /**
     * The last second (UTC) of the `expiresOn` day, as epoch seconds: the credential is accepted through
     * the end of that day. Null when the attribute is missing or not a calendar date. Plain arithmetic, so
     * it works on API 24 without java.time.
     */
    fun expiresAt(attributes: Map<String, String>): Long? {
        val value = attributes[EXPIRES_ON]?.trim() ?: return null
        if (value.length != 8 || value.any { !it.isDigit() }) return null
        val year = value.substring(0, 4).toInt()
        val month = value.substring(4, 6).toInt()
        val day = value.substring(6, 8).toInt()
        if (year < 1000 || month !in 1..12 || day !in 1..daysInMonth(year, month)) return null
        return (daysSinceEpoch(year, month, day) + 1) * 86_400 - 1
    }

    private fun daysInMonth(year: Int, month: Int): Int = when (month) {
        2 -> if ((year % 4 == 0 && year % 100 != 0) || year % 400 == 0) 29 else 28
        4, 6, 9, 11 -> 30
        else -> 31
    }

    /** Days from 1970-01-01 to the given proleptic Gregorian date (H. Hinnant's days_from_civil). */
    private fun daysSinceEpoch(year: Int, month: Int, day: Int): Long {
        val y = if (month <= 2) year - 1 else year
        val era = (if (y >= 0) y else y - 399) / 400
        val yearOfEra = y - era * 400
        val dayOfYear = (153 * (month + if (month > 2) -3 else 9) + 2) / 5 + day - 1
        val dayOfEra = yearOfEra * 365 + yearOfEra / 4 - yearOfEra / 100 + dayOfYear
        return era * 146_097L + dayOfEra - 719_468
    }

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
