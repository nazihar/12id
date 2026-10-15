package com.onetwoid.reference

import android.content.Context
import android.util.Base64
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
import java.util.UUID

/**
 * This app's own backend (reference/backend). The app never talks to the 12id platform API itself and
 * never holds an API key: it asks its backend, and the backend asks 12id.
 */
class Backend(context: Context, private val baseUrl: String) {
    private val prefs = context.getSharedPreferences("reference", Context.MODE_PRIVATE)
    private val http = OkHttpClient()

    class Refused(val status: Int, val code: String) : IOException("backend answered $status $code")

    /** `photoRequired`: the organisation uses face checks and has no photo of this user yet. */
    data class User(val name: String, val memberId: String, val photoRequired: Boolean)
    data class Enrolment(val connected: Boolean, val invitationUrl: String?)
    data class ActionResult(val id: String, val state: String, val disclosed: Map<String, String>)

    /** Created once per installation and sent to the backend, which creates one 12id wallet for it. */
    private val installationId: String
        get() = prefs.getString("installationId", null) ?: UUID.randomUUID().toString().also {
            prefs.edit().putString("installationId", it).apply()
        }

    val signedIn: Boolean get() = prefs.getString("sessionToken", null) != null

    suspend fun signIn(name: String, accessCode: String): User {
        val json = post("/session", JSONObject().put("name", name).put("accessCode", accessCode).put("installationId", installationId), authenticated = false)
        prefs.edit().putString("sessionToken", json.getString("sessionToken")).apply()
        return user(json.getJSONObject("user"))
    }

    suspend fun me(): User = user(get("/me"))

    /** The user's photo on file: what a face check compares the live face with. It goes to the backend, never into the wallet. */
    suspend fun uploadPhoto(jpeg: ByteArray): User =
        user(post("/photo", JSONObject().put("image", Base64.encodeToString(jpeg, Base64.NO_WRAP))))

    private fun user(json: JSONObject) = User(json.getString("name"), json.getString("memberId"), json.optBoolean("photoRequired", false))

    /** `refresh` when the SDK says the previous token was rejected. */
    suspend fun walletToken(refresh: Boolean): String =
        post("/wallet-token", JSONObject().put("refresh", refresh)).getString("walletToken")

    suspend fun enrol(): Enrolment =
        post("/enrol", JSONObject()).let { Enrolment(it.getBoolean("connected"), if (it.isNull("invitationUrl")) null else it.getString("invitationUrl")) }

    suspend fun startAction(type: String, details: Map<String, String>): String =
        post("/actions", JSONObject().put("type", type).put("details", JSONObject(details))).getString("id")

    suspend fun action(id: String): ActionResult = get("/actions/$id").let { json ->
        val disclosed = mutableMapOf<String, String>()
        json.optJSONObject("disclosed")?.let { groups ->
            for (group in groups.keys()) groups.getJSONObject(group).let { values -> for (name in values.keys()) disclosed[name] = values.getString(name) }
        }
        ActionResult(json.getString("id"), json.getString("state"), disclosed)
    }

    /** Ends the session only. The installation stays, so the next sign-in is the same user, whose wallet already holds the card. */
    fun signOut() {
        prefs.edit().remove("sessionToken").apply()
    }

    /** Forgets this installation: the next sign-in is a new user with a new wallet. */
    fun forget() {
        prefs.edit().clear().apply()
    }

    private suspend fun get(path: String) = call(Request.Builder().url("$baseUrl$path"), authenticated = true)

    private suspend fun post(path: String, body: JSONObject, authenticated: Boolean = true) =
        call(Request.Builder().url("$baseUrl$path").post(body.toString().toRequestBody("application/json".toMediaType())), authenticated)

    private suspend fun call(request: Request.Builder, authenticated: Boolean): JSONObject = withContext(Dispatchers.IO) {
        if (authenticated) request.header("Authorization", "Bearer ${prefs.getString("sessionToken", null).orEmpty()}")
        http.newCall(request.build()).execute().use { response ->
            val json = runCatching { JSONObject(response.body?.string().orEmpty()) }.getOrDefault(JSONObject())
            if (!response.isSuccessful) throw Refused(response.code, json.optString("error", "error"))
            json
        }
    }
}
