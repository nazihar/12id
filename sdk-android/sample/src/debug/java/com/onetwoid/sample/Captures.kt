package com.onetwoid.sample

import com.onetwoid.sdk.OneTwoId
import com.onetwoid.sdk.biometrics.aws.AwsFaceLivenessCapture
import com.onetwoid.sdk.biometrics.mock.MockFaceCapture

/**
 * Face-capture add-ons of this build (Phase 6). Debug also registers the mock add-on for the platform's
 * `mock` provider; a smoke run can preset its answer (DebugReceiver VERIFY_FACES --es preset …).
 */
object Captures {
    @Volatile var mockPreset: String? = null

    fun register() {
        OneTwoId.registerCapture(AwsFaceLivenessCapture())
        OneTwoId.registerCapture(MockFaceCapture(preset = { mockPreset }))
    }
}
