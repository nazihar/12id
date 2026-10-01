package org.hyperledger.ariesframework.agent

import okhttp3.OkHttpClient
import org.hyperledger.ariesframework.OutboundPackage

interface OutboundTransport {
    suspend fun sendPackage(_package: OutboundPackage)
}

object AgentHttpClient {
    // 12id fork change (F8): Let's Encrypt roots as a fallback, for Android 7.0 (IsrgTrust).
    val client = IsrgTrust.applyTo(OkHttpClient().newBuilder())
        .connectTimeout(60, java.util.concurrent.TimeUnit.SECONDS)
        .readTimeout(60, java.util.concurrent.TimeUnit.SECONDS)
        .writeTimeout(60, java.util.concurrent.TimeUnit.SECONDS)
        .build()
}
