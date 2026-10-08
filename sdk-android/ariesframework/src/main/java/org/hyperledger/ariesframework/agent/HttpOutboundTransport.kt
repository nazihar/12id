package org.hyperledger.ariesframework.agent

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.GlobalScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.RequestBody.Companion.toRequestBody
import org.hyperledger.ariesframework.EncryptedMessage
import org.hyperledger.ariesframework.OutboundPackage
import org.slf4j.LoggerFactory
import java.io.IOException

enum class DidCommMimeType(val value: String) {
    V0("application/ssi-agent-wire"),
    V1("application/didcomm-envelope-enc"),
}

class HttpOutboundTransport(val agent: Agent) : OutboundTransport {
    private val logger = LoggerFactory.getLogger(HttpOutboundTransport::class.java)

    override suspend fun sendPackage(_package: OutboundPackage) {
        logger.debug("Sending outbound message to endpoint: {}", _package.endpoint)

        val responseText = withContext(Dispatchers.IO) {
            try {
                postEnvelope(AgentHttpClient.client, _package.endpoint, Json.encodeToString(_package.payload))
            } catch (e: HttpStatusException) {
                // MessageSender logs a failed send at Debug only; a refusal should be visible.
                logger.warn("Outbound message refused: {}", e.message)
                throw e
            }
        }

        if (responseText.isNotEmpty()) {
            val encryptedMessage = Json.decodeFromString<EncryptedMessage>(responseText)
            agent.receiveMessage(encryptedMessage)
        } else if (_package.responseRequested) {
            logger.debug("Requested response but got no data. Will initiate message pickup if necessary.")
            GlobalScope.launch {
                delay(agent.agentConfig.mediatorEmptyReturnRetryInterval * 1000)
                agent.mediationRecipient.pickupMessages()
            }
        } else {
            logger.debug("No data received")
        }
    }
}

/** 12id fork change (F10): the server answered a DIDComm POST with a status outside 2xx. */
internal class HttpStatusException(val code: Int, host: String) : IOException("HTTP $code from $host")

/**
 * 12id fork change (F10): posts one packed message and returns the response body. A status outside
 * 2xx is a failed send. Upstream ignored the status: it parsed an error page as a DIDComm message and
 * took a refusal with an empty body for a delivered message.
 */
internal fun postEnvelope(client: OkHttpClient, endpoint: String, envelope: String): String {
    val request = okhttp3.Request.Builder()
        .url(endpoint)
        .post(
            envelope
                .toByteArray() // prevent okHttp from adding charset=utf-8 to the content type
                .toRequestBody(DidCommMimeType.V1.value.toMediaType()),
        )
        .build()
    return client.newCall(request).execute().use { response ->
        if (!response.isSuccessful) throw HttpStatusException(response.code, request.url.host)
        response.body?.string() ?: ""
    }
}
