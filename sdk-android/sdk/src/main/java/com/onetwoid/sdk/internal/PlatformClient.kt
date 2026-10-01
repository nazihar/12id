package com.onetwoid.sdk.internal

import com.onetwoid.sdk.OneTwoIdException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import org.hyperledger.ariesframework.agent.IsrgTrust
import java.io.IOException
import java.util.concurrent.TimeUnit

@Serializable
internal data class LedgerConfig(
    val indyNamespace: String,
    val genesis: GenesisInfo,
    val vdrProxyUrl: String? = null,
)

@Serializable
internal data class GenesisInfo(
    val url: String,
    val sha256: String,
    val signatureUrl: String? = null,
    val signingPublicKey: String? = null,
)

@Serializable
private data class MediatorInvitationResponse(val invitationUrl: String)

// --- Phase 6 biometric gate -------------------------------------------------------------

@Serializable
internal data class BiometricRequirementDto(
    val threadId: String,
    val recordType: String,
    val status: String,
    val attemptsRemaining: Int,
    val captureProvider: String,
    val expiresAt: String,
)

@Serializable
private data class BiometricRequirementsResponse(val requirements: List<BiometricRequirementDto>)

@Serializable
internal data class CaptureModuleDto(val provider: String, val version: Int)

@Serializable
private data class StartSessionBody(val threadId: String, val captureModules: List<CaptureModuleDto>)

@Serializable
internal data class StartedSessionDto(
    val sessionId: String,
    val provider: String,
    val clientConfig: JsonElement? = null,
    val attempt: Int,
    val attemptsRemaining: Int,
)

@Serializable
internal data class SessionOutcomeDto(val outcome: String, val attemptsRemaining: Int)

@Serializable
private data class PlatformErrorBody(val error: String? = null, val reason: String? = null)

/** A 4xx from the platform with its `error` code, for callers that branch on it (e.g. `result_not_ready`). */
internal class PlatformRefusal(val status: Int, val code: String, val reason: String) : Exception("$status $code: $reason")

/** The SDK-facing platform API routes (`services/platform-api`, Phase 3 P5). */
internal class PlatformClient(
    apiBaseUrl: String,
    private val walletTokenProvider: suspend () -> String,
    private val http: OkHttpClient = defaultHttpClient(),
) {
    private val base = apiBaseUrl.trimEnd('/').toHttpUrl()
    private val json = Json { ignoreUnknownKeys = true }

    // The wallet token is cached for this process and fetched again only after a 401. Asking the host
    // app on every call would reach the customer backend each time, and a backend that retries
    // POST /v1/wallets rotates the token, so concurrent calls invalidated each other (Phase 6 finding).
    private val tokenMutex = Mutex()
    @Volatile private var cachedToken: String? = null

    /** The cached token, or a new one when [rejected] is still the cached one (only one caller refreshes). */
    private suspend fun walletToken(rejected: String? = null): String = tokenMutex.withLock {
        val current = cachedToken
        if (current != null && current != rejected) return@withLock current
        walletTokenProvider().also { cachedToken = it }
    }

    /** `GET /v1/ledger`, public. */
    suspend fun ledgerConfig(): LedgerConfig {
        val body = execute(Request.Builder().url(base.resolve("/v1/ledger")!!).build())
        return json.decodeFromString(LedgerConfig.serializer(), body)
    }

    /** Downloads a file (the genesis) by absolute URL. */
    suspend fun download(url: String): ByteArray = withContext(Dispatchers.IO) {
        try {
            http.newCall(Request.Builder().url(url).build()).execute().use { response ->
                if (!response.isSuccessful) throw platformError(response)
                response.body!!.bytes()
            }
        } catch (e: IOException) {
            throw OneTwoIdException.NetworkUnavailable(e)
        }
    }

    /**
     * `GET /v1/wallet/mediator-invitation`. Every call mints a new single-use invitation and replaces
     * the wallet's previous one. A 401 asks the token provider once more: a retried `POST /v1/wallets`
     * rotates the token.
     */
    suspend fun mediatorInvitation(): String {
        val url = base.resolve("/v1/wallet/mediator-invitation")!!
        val body = try {
            authorized { Request.Builder().url(url).header("Authorization", it).build() }
        } catch (e: PlatformRefusal) {
            throw OneTwoIdException.PlatformError(e.status, "${e.code}: ${e.reason}")
        }
        return json.decodeFromString(MediatorInvitationResponse.serializer(), body).invitationUrl
    }

    /** `GET /v1/wallet/biometric-requirements`: checks for these threads; threads without one are omitted. */
    suspend fun biometricRequirements(threadIds: List<String>): List<BiometricRequirementDto> {
        if (threadIds.isEmpty()) return emptyList()
        val url = base.resolve("/v1/wallet/biometric-requirements")!!.newBuilder().apply { threadIds.take(20).forEach { addQueryParameter("threadId", it) } }.build()
        val body = authorized { Request.Builder().url(url).header("Authorization", it).build() }
        return json.decodeFromString(BiometricRequirementsResponse.serializer(), body).requirements
    }

    /** `POST /v1/wallet/biometric-sessions`. Uses one attempt. */
    suspend fun startBiometricSession(threadId: String, modules: List<CaptureModuleDto>): StartedSessionDto {
        val payload = json.encodeToString(StartSessionBody.serializer(), StartSessionBody(threadId, modules))
        val body = authorized { Request.Builder().url(base.resolve("/v1/wallet/biometric-sessions")!!).header("Authorization", it).post(payload.toRequestBody(JSON)).build() }
        return json.decodeFromString(StartedSessionDto.serializer(), body)
    }

    /** `POST /v1/wallet/biometric-sessions/{id}/complete`; `clientOutputJson` is the add-on's output as is. */
    suspend fun completeBiometricSession(sessionId: String, clientOutputJson: String): SessionOutcomeDto {
        val output = runCatching { json.parseToJsonElement(clientOutputJson) }.getOrElse { JsonObject(emptyMap()) }
        val payload = buildJsonObject { put("clientOutput", output) }.toString()
        val url = base.resolve("/v1/wallet/biometric-sessions/$sessionId/complete")!!
        val body = authorized { Request.Builder().url(url).header("Authorization", it).post(payload.toRequestBody(JSON)).build() }
        return json.decodeFromString(SessionOutcomeDto.serializer(), body)
    }

    /**
     * A wallet-token call: a 401 asks the token provider once more (a retried `POST /v1/wallets` rotates
     * the token); other 4xx become [PlatformRefusal] with the platform's error code.
     */
    private suspend fun authorized(build: (authorization: String) -> Request): String {
        var token = walletToken()
        for (attempt in 0..1) {
            if (attempt == 1) token = walletToken(rejected = token)
            val request = build("Bearer $token")
            val result = withContext(Dispatchers.IO) {
                try {
                    http.newCall(request).execute().use { response ->
                        when {
                            response.code == 401 -> null
                            response.isSuccessful -> response.body!!.string()
                            response.code in 400..499 -> {
                                val text = response.body?.string().orEmpty()
                                val parsed = runCatching { json.decodeFromString(PlatformErrorBody.serializer(), text) }.getOrNull()
                                throw PlatformRefusal(response.code, parsed?.error ?: "http_${response.code}", parsed?.reason ?: text.take(200))
                            }
                            else -> throw platformError(response)
                        }
                    }
                } catch (e: IOException) {
                    throw OneTwoIdException.NetworkUnavailable(e)
                }
            }
            if (result != null) return result
        }
        cachedToken = null
        throw OneTwoIdException.WalletTokenRejected()
    }

    private suspend fun execute(request: Request): String = withContext(Dispatchers.IO) {
        try {
            http.newCall(request).execute().use { response ->
                if (!response.isSuccessful) throw platformError(response)
                response.body!!.string()
            }
        } catch (e: IOException) {
            throw OneTwoIdException.NetworkUnavailable(e)
        }
    }

    private fun platformError(response: Response): OneTwoIdException.PlatformError =
        OneTwoIdException.PlatformError(response.code, response.body?.string()?.take(200) ?: response.message)

    companion object {
        private val JSON = "application/json".toMediaType()

        // IsrgTrust: Let's Encrypt roots after the system's, so Android 7.0 (minSdk 24) reaches the platform (W3).
        fun defaultHttpClient(): OkHttpClient = IsrgTrust.applyTo(OkHttpClient.Builder())
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .build()
    }
}
