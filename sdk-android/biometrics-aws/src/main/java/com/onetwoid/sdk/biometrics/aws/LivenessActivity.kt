package com.onetwoid.sdk.biometrics.aws

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material3.MaterialTheme
import androidx.core.content.ContextCompat
import com.amplifyframework.auth.AWSCredentials
import com.amplifyframework.auth.AWSCredentialsProvider
import com.amplifyframework.auth.AWSTemporaryCredentials
import com.amplifyframework.auth.AuthException
import com.amplifyframework.core.Consumer
import com.amplifyframework.ui.liveness.ui.FaceLivenessDetector
import com.onetwoid.sdk.OneTwoIdException
import aws.smithy.kotlin.runtime.time.Instant as SmithyInstant

/**
 * Hosts Amplify's FaceLivenessDetector for one [AwsFaceLivenessCapture.capture] call. Not exported.
 * Completes the caller's deferred on success, error or back navigation, then finishes.
 */
internal class LivenessActivity : ComponentActivity() {
    private var pending: AwsFaceLivenessCapture.Pending? = null

    private val cameraPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) show() else fail(OneTwoIdException.BiometricCancelled())
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        pending = intent.getStringExtra(EXTRA_REQUEST)?.let { AwsFaceLivenessCapture.pending[it] }
        if (pending == null) {
            // Recreated after process death: the capture that started us is gone.
            finish()
            return
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) show()
        else cameraPermission.launch(Manifest.permission.CAMERA)
    }

    private fun show() {
        val request = pending!!.request
        val credentials = object : AWSCredentialsProvider<AWSCredentials> {
            override fun fetchAWSCredentials(onSuccess: Consumer<AWSCredentials>, onError: Consumer<AuthException>) {
                onSuccess.accept(
                    AWSTemporaryCredentials(
                        request.accessKeyId,
                        request.secretAccessKey,
                        request.sessionToken,
                        SmithyInstant.fromEpochSeconds(request.expirationEpochSeconds, 0),
                    ),
                )
            }
        }
        setContent {
            MaterialTheme {
                FaceLivenessDetector(
                    sessionId = request.sessionId,
                    region = request.region,
                    credentialsProvider = credentials,
                    disableStartView = false,
                    onComplete = { complete() },
                    onError = { error ->
                        val cancelled = error.message.contains("cancel", ignoreCase = true)
                        fail(if (cancelled) OneTwoIdException.BiometricCancelled() else OneTwoIdException.Internal("face liveness failed: ${error.message}", error.throwable))
                    },
                )
            }
        }
    }

    private fun complete() {
        pending?.done?.complete(Unit)
        finish()
    }

    private fun fail(error: OneTwoIdException) {
        pending?.done?.completeExceptionally(error)
        finish()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        fail(OneTwoIdException.BiometricCancelled())
        @Suppress("DEPRECATION")
        super.onBackPressed()
    }

    override fun onDestroy() {
        // Leaving without a result (e.g. the task was removed) counts as a cancel.
        if (isFinishing) pending?.done?.let { if (!it.isCompleted) it.completeExceptionally(OneTwoIdException.BiometricCancelled()) }
        super.onDestroy()
    }

    internal companion object {
        const val EXTRA_REQUEST = "com.onetwoid.sdk.biometrics.aws.REQUEST"
    }
}
