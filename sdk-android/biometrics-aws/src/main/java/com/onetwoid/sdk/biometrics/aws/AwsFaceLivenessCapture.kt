package com.onetwoid.sdk.biometrics.aws

import android.content.Intent
import androidx.activity.ComponentActivity
import com.onetwoid.sdk.BiometricCapture
import com.onetwoid.sdk.CaptureOutput
import com.onetwoid.sdk.CaptureSession
import com.onetwoid.sdk.OneTwoIdException
import kotlinx.coroutines.CompletableDeferred
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * AWS Rekognition Face Liveness capture for the platform's `aws-rekognition` provider.
 *
 * Register it once next to `OneTwoId.initialize`:
 * ```
 * OneTwoId.registerCapture(AwsFaceLivenessCapture())
 * ```
 * The platform creates the liveness session in the organisation's AWS account and hands this add-on
 * the session id, region and 15-minute credentials that can only stream to that session. The video
 * goes straight to AWS; the platform then reads the result from AWS itself, so this returns nothing.
 */
public class AwsFaceLivenessCapture : BiometricCapture {
    override val provider: String = "aws-rekognition"
    override val version: Int = 1

    override suspend fun capture(activity: ComponentActivity, session: CaptureSession): CaptureOutput {
        val request = LivenessRequest.parse(session.clientConfigJson)
        val id = UUID.randomUUID().toString()
        val done = CompletableDeferred<Unit>()
        // Kept in memory, never in the intent: the credentials must not reach saved state or recents.
        pending[id] = Pending(request, done)
        try {
            activity.startActivity(Intent(activity, LivenessActivity::class.java).putExtra(LivenessActivity.EXTRA_REQUEST, id))
            done.await()
        } finally {
            pending.remove(id)
        }
        return CaptureOutput("{}")
    }

    internal class Pending(val request: LivenessRequest, val done: CompletableDeferred<Unit>)

    internal companion object {
        val pending = ConcurrentHashMap<String, Pending>()
    }
}

/** The platform's `clientConfig` for aws-rekognition (see biometric-service providers/aws-rekognition.ts). */
internal class LivenessRequest(
    val sessionId: String,
    val region: String,
    val accessKeyId: String,
    val secretAccessKey: String,
    val sessionToken: String,
    val expirationEpochSeconds: Long,
) {
    companion object {
        fun parse(json: String): LivenessRequest = try {
            val root = JSONObject(json)
            val credentials = root.getJSONObject("credentials")
            LivenessRequest(
                sessionId = root.getString("sessionId"),
                region = root.getString("region"),
                accessKeyId = credentials.getString("accessKeyId"),
                secretAccessKey = credentials.getString("secretAccessKey"),
                sessionToken = credentials.getString("sessionToken"),
                expirationEpochSeconds = credentials.optString("expiration").let { runCatching { java.time.Instant.parse(it).epochSecond }.getOrDefault(0L) },
            )
        } catch (e: Exception) {
            throw OneTwoIdException.Internal("unexpected aws-rekognition session configuration", e)
        }
    }
}
