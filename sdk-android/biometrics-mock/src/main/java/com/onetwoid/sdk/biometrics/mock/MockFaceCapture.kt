package com.onetwoid.sdk.biometrics.mock

import android.app.AlertDialog
import androidx.activity.ComponentActivity
import com.onetwoid.sdk.BiometricCapture
import com.onetwoid.sdk.CaptureOutput
import com.onetwoid.sdk.CaptureSession
import com.onetwoid.sdk.OneTwoIdException
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * Test capture for the platform's `mock` provider (staging only). Instead of a camera it asks the tester
 * which result to simulate; the platform decides from that exactly as it would from a vendor.
 *
 * [preset] skips the dialog (smoke tests drive the sample over adb): one of `same`, `other`, `none`, `not-live`.
 */
public class MockFaceCapture(private val preset: () -> String? = { null }) : BiometricCapture {
    override val provider: String = "mock"
    override val version: Int = 1

    override suspend fun capture(activity: ComponentActivity, session: CaptureSession): CaptureOutput {
        val choice = preset() ?: ask(activity, session)
        return CaptureOutput(
            when (choice) {
                "same" -> """{"live":true,"face":"same"}"""
                "other" -> """{"live":true,"face":"other"}"""
                "none" -> """{"live":true,"face":"none"}"""
                else -> """{"live":false,"face":"same"}"""
            },
        )
    }

    private suspend fun ask(activity: ComponentActivity, session: CaptureSession): String = suspendCancellableCoroutine { cont ->
        val labels = arrayOf("Live, same person", "Live, different person", "No face", "Not live (photo)")
        val values = arrayOf("same", "other", "none", "not-live")
        val dialog = AlertDialog.Builder(activity)
            .setTitle("Mock face check (attempt ${session.attempt})")
            .setItems(labels) { _, which -> if (cont.isActive) cont.resume(values[which]) }
            .setOnCancelListener { if (cont.isActive) cont.resumeWithException(OneTwoIdException.BiometricCancelled()) }
            .create()
        cont.invokeOnCancellation { dialog.dismiss() }
        dialog.show()
    }
}
