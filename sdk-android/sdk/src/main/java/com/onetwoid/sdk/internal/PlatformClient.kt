package com.onetwoid.sdk.internal

import com.onetwoid.sdk.OneTwoIdException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
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

/** The SDK-facing platform API routes (`services/platform-api`, Phase 3 P5). */
internal class PlatformClient(
    apiBaseUrl: String,
    private val walletTokenProvider: suspend () -> String,
    private val http: OkHttpClient = defaultHttpClient(),
) {
    private val base = apiBaseUrl.trimEnd('/').toHttpUrl()
    private val json = Json { ignoreUnknownKeys = true }

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
        for (attempt in 0..1) {
            val token = walletTokenProvider()
            val request = Request.Builder().url(url).header("Authorization", "Bearer $token").build()
            val result = withContext(Dispatchers.IO) {
                try {
                    http.newCall(request).execute().use { response ->
                        when {
                            response.code == 401 -> null
                            response.isSuccessful -> response.body!!.string()
                            else -> throw platformError(response)
                        }
                    }
                } catch (e: IOException) {
                    throw OneTwoIdException.NetworkUnavailable(e)
                }
            }
            if (result != null) return json.decodeFromString(MediatorInvitationResponse.serializer(), result).invitationUrl
        }
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
        fun defaultHttpClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .build()
    }
}
