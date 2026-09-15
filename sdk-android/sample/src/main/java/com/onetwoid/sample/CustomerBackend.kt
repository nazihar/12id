package com.onetwoid.sample

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.UUID

/**
 * Stand-in for the customer's own backend. A real app authenticates its user here; the backend then
 * calls the platform's `POST /v1/wallets` with the app's installation id as `Idempotency-Key` and
 * returns the wallet token. The app never holds a platform API key.
 */
class CustomerBackend(context: Context, private val baseUrl: String) {
    private val prefs = context.getSharedPreferences("sample", Context.MODE_PRIVATE)
    private val http = OkHttpClient()

    /** Created once per installation; a reinstall gets a new id and therefore a new wallet. */
    val installationId: String
        get() = prefs.getString("installationId", null) ?: UUID.randomUUID().toString().also {
            prefs.edit().putString("installationId", it).apply()
        }

    suspend fun walletToken(): String = withContext(Dispatchers.IO) {
        val body = JSONObject().put("installationId", installationId).toString()
        val request = Request.Builder()
            .url("$baseUrl/wallet")
            .post(body.toRequestBody("application/json".toMediaType()))
            .build()
        http.newCall(request).execute().use { response ->
            check(response.isSuccessful) { "backend answered ${response.code}" }
            JSONObject(response.body!!.string()).getString("walletToken")
        }
    }
}
