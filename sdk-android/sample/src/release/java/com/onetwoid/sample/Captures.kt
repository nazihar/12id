package com.onetwoid.sample

import com.onetwoid.sdk.OneTwoId
import com.onetwoid.sdk.biometrics.aws.AwsFaceLivenessCapture

/** Face-capture add-ons of this build (Phase 6): the vendors this app's organisations use. */
object Captures {
    fun register() {
        OneTwoId.registerCapture(AwsFaceLivenessCapture())
    }
}
