package org.hyperledger.ariesframework.agent

import okhttp3.Interceptor
import okhttp3.Response
import org.slf4j.LoggerFactory
import java.io.IOException

/**
 * 12id fork change (F10): a request answered with 429 is sent again after the wait the server names.
 *
 * The platform's edge limits requests per address, and phones share addresses (an office Wi-Fi, a
 * carrier's NAT), so a wallet can be refused for what its neighbours sent. The edge's window is 10 s
 * (Phase 9, `EDGE_MEDIATOR_LIMIT` / `EDGE_AGENT_LIMIT`), so one short wait usually gets through.
 *
 * Only 429 is repeated: it is a refusal before the request was processed, so a second copy cannot
 * deliver a DIDComm message twice. A 502 or 504 may follow a request the service did process, and is
 * returned as it is.
 *
 * A wait longer than [MAX_WAIT_MILLIS] is not worth holding the caller for: that 429 is returned too.
 * Used by the framework's HTTP/WebSocket client and by the SDK's `PlatformClient`.
 */
internal class RetryAfterInterceptor(
    private val maxRetries: Int = 2,
    private val sleep: (Long) -> Unit = Thread::sleep,
) : Interceptor {
    private val logger = LoggerFactory.getLogger(RetryAfterInterceptor::class.java)

    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        var response = chain.proceed(request)
        var retries = 0
        while (response.code == 429 && retries < maxRetries && request.body?.isOneShot() != true) {
            val wait = waitMillis(response.header("Retry-After")) ?: break
            response.close()
            logger.warn("HTTP 429 from {}; sending the request again in {} ms", request.url.host, wait)
            sleep(wait)
            if (chain.call().isCanceled()) throw IOException("Canceled")
            retries++
            response = chain.proceed(request)
        }
        return response
    }

    internal companion object {
        const val DEFAULT_WAIT_MILLIS = 2_000L
        const val MAX_WAIT_MILLIS = 10_000L

        /** The wait a `Retry-After` header asks for (seconds), or null when it is longer than the cap. */
        fun waitMillis(retryAfter: String?): Long? {
            // The HTTP-date form is not used by the platform; treat it like a missing header.
            val seconds = retryAfter?.trim()?.toLongOrNull() ?: return DEFAULT_WAIT_MILLIS
            if (seconds > MAX_WAIT_MILLIS / 1000) return null
            return seconds.coerceAtLeast(0) * 1000
        }
    }
}
