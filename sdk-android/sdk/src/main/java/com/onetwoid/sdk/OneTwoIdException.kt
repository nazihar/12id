package com.onetwoid.sdk

/** Every error the SDK reports. Check the subtype to decide how to recover. */
public sealed class OneTwoIdException(message: String, cause: Throwable? = null) : Exception(message, cause) {
    /** A call was made before [OneTwoId.initialize] completed. */
    public class NotInitialized : OneTwoIdException("OneTwoId.initialize() has not completed")

    /** The platform rejected the wallet token, also after asking the token provider again. Get a new token from your backend. */
    public class WalletTokenRejected : OneTwoIdException("the platform rejected the wallet token")

    /** The platform, ledger or mediator could not be reached. Retry later. */
    public class NetworkUnavailable(cause: Throwable? = null) : OneTwoIdException("network unavailable", cause)

    /** The platform answered with an unexpected status. */
    public class PlatformError(public val statusCode: Int, detail: String) : OneTwoIdException("platform error $statusCode: $detail")

    /** The URL is not a connection invitation this wallet can accept. */
    public class InvalidInvitation(cause: Throwable? = null) : OneTwoIdException("invalid invitation", cause)

    /** The mediator did not answer. Messages keep queueing there; retry with [OneTwoId.initialize] or [OneTwoId.sync]. */
    public class MediatorUnavailable(cause: Throwable? = null) : OneTwoIdException("the mediator did not answer", cause)

    /** The ledger configuration or genesis file could not be obtained or did not match its checksum. */
    public class LedgerUnavailable(detail: String, cause: Throwable? = null) : OneTwoIdException("ledger unavailable: $detail", cause)

    /** No offer, proof request, credential or connection with that id. */
    public class NotFound(public val id: String) : OneTwoIdException("not found: $id")

    /** The selection does not cover every group of the request, or names a credential that cannot answer it. */
    public class InvalidSelection(detail: String) : OneTwoIdException("invalid selection: $detail")

    /**
     * The wallet exists but its key can no longer be read (e.g. files restored onto another device).
     * The wallet cannot be recovered: call [OneTwoId.reset] and let issuers re-issue credentials.
     */
    public class WalletKeyLost(cause: Throwable? = null) : OneTwoIdException("the wallet key cannot be read", cause)

    /** An unexpected framework failure. */
    public class Internal(detail: String, cause: Throwable? = null) : OneTwoIdException(detail, cause)
}
