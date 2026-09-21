package com.onetwoid.sdk

import androidx.activity.ComponentActivity

/**
 * A face-capture add-on (Phase 6 biometric gate). The core SDK has no vendor code: each vendor ships
 * as its own artifact (`com.12id:holder-sdk-android-biometrics-<vendor>`) implementing this interface,
 * and the host app registers the ones it includes with [OneTwoId.registerCapture].
 *
 * The add-on only captures. The platform fetches the result from the vendor itself and decides; an
 * add-on cannot report a pass.
 */
public interface BiometricCapture {
    /** Matches the platform provider's capture module, e.g. `aws-rekognition`. */
    public val provider: String

    /** Increases when the add-on's contract with the platform changes. */
    public val version: Int

    /**
     * Runs the vendor's capture UI and returns what the vendor SDK produced. Throw
     * [OneTwoIdException.BiometricCancelled] when the user backs out.
     */
    public suspend fun capture(activity: ComponentActivity, session: CaptureSession): CaptureOutput
}

/**
 * What the platform prepared for one capture attempt.
 *
 * @property clientConfigJson vendor-specific JSON for the add-on only (it may hold short-lived
 *   credentials; never log or persist it).
 */
public class CaptureSession(
    public val provider: String,
    public val clientConfigJson: String,
    public val attempt: Int,
)

/** Vendor-specific JSON the add-on returns; sent to the platform as is. `{}` when the vendor keeps the result. */
public class CaptureOutput(public val clientOutputJson: String = "{}")

public enum class BiometricStatus { Pending, Passed, Failed, Expired, Cancelled }

/** The organisation requires a face check before this offer can be accepted or this proof request answered. */
public data class BiometricRequirement(
    val status: BiometricStatus,
    val attemptsRemaining: Int,
    /** The capture add-on needed, e.g. `aws-rekognition`. */
    val provider: String,
    val expiresAtEpochSeconds: Long,
)

/** Result of [OneTwoId.verifyFace]. */
public sealed class BiometricOutcome {
    /** The check passed: accept the offer or answer the proof request now. */
    public object Passed : BiometricOutcome()

    /** This attempt failed; the user may try again. */
    public data class Failed(val attemptsRemaining: Int) : BiometricOutcome()

    /** No attempts left: the organisation will cancel the exchange. */
    public object Locked : BiometricOutcome()
}
