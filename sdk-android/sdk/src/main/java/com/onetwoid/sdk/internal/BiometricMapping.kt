package com.onetwoid.sdk.internal

import com.onetwoid.sdk.BiometricOutcome
import com.onetwoid.sdk.BiometricRequirement
import com.onetwoid.sdk.BiometricStatus
import com.onetwoid.sdk.OneTwoIdException
import java.time.Instant

/** Pure mapping and decisions for the Phase 6 biometric gate, kept out of OneTwoId for unit tests. */
internal object BiometricMapping {
    fun requirement(dto: BiometricRequirementDto): BiometricRequirement = BiometricRequirement(
        status = when (dto.status) {
            "passed" -> BiometricStatus.Passed
            "failed" -> BiometricStatus.Failed
            "expired" -> BiometricStatus.Expired
            "cancelled" -> BiometricStatus.Cancelled
            else -> BiometricStatus.Pending
        },
        attemptsRemaining = dto.attemptsRemaining,
        provider = dto.captureProvider,
        expiresAtEpochSeconds = runCatching { Instant.parse(dto.expiresAt).epochSecond }.getOrDefault(0L),
    )

    fun outcome(dto: SessionOutcomeDto): BiometricOutcome = when (dto.outcome) {
        "passed" -> BiometricOutcome.Passed
        "locked" -> BiometricOutcome.Locked
        else -> BiometricOutcome.Failed(dto.attemptsRemaining)
    }

    /**
     * The client-side guard before accept/respond. It only improves the user experience: the platform
     * holds the exchange regardless. Unknown (offline) requirements do not block.
     */
    fun guard(exchangeId: String, requirement: BiometricRequirement?) {
        when (requirement?.status) {
            null, BiometricStatus.Passed -> Unit
            BiometricStatus.Pending -> throw OneTwoIdException.BiometricRequired(exchangeId)
            else -> throw OneTwoIdException.BiometricFailed(0)
        }
    }

    /** How often and how long [com.onetwoid.sdk.OneTwoId.verifyFace] waits for the vendor's result. */
    const val RESULT_POLLS = 15
    const val RESULT_POLL_DELAY_MS = 1_000L
}
