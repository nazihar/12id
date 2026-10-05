package com.onetwoid.sdk

import kotlin.time.Duration

/**
 * Configuration for [OneTwoId.initialize].
 *
 * @property apiBaseUrl the 12id platform API, e.g. `https://api.12id.com`. Must be https, except in a
 *   debuggable build: the wallet token travels on it, and Android only blocks cleartext by default from
 *   API 28.
 * @property walletTokenProvider returns this installation's wallet token. Your backend creates it with
 *   `POST /v1/wallets` (installation id as `Idempotency-Key`). The SDK asks again once when the platform
 *   rejects a token, because a retried `POST /v1/wallets` rotates it.
 * @property label the name issuers and verifiers see for this wallet. It is fixed at first onboarding;
 *   later changes are ignored because the wallet's storage is keyed by it.
 * @property logSink receives SDK and framework log lines; `null` logs nothing.
 * @property minLogLevel the lowest level handed to [logSink]. The default keeps [LogLevel.Debug] out:
 *   the framework's debug lines carry proof-request contents, connection records and DID documents, and
 *   a sink usually ends up in a crash reporter. Lower it to [LogLevel.Debug] only while diagnosing, and
 *   not in a release build.
 * @property idlePollInterval `null` (the default): the wallet asks the mediator for messages only when it
 *   expects one (after [OneTwoId.connect], [OneTwoId.acceptOffer] or [OneTwoId.expectMessages]), when the
 *   app comes to the foreground, and on [OneTwoId.sync] from your push handler. Set it (at least 10 s)
 *   only if your app has no push and should still show messages organisations send while it stays open;
 *   it then also polls at that interval while the app is in the foreground.
 */
public class OneTwoIdConfig(
    public val apiBaseUrl: String,
    public val walletTokenProvider: suspend () -> String,
    public val label: String = "12id wallet",
    public val logSink: LogSink? = null,
    public val minLogLevel: LogLevel = LogLevel.Info,
) {
    public var idlePollInterval: Duration? = null
        private set

    // A second constructor, not a sixth parameter with a default: that would replace the 0.1.0
    // constructor, and code compiled against 0.1.0 would fail with NoSuchMethodError.
    public constructor(
        apiBaseUrl: String,
        walletTokenProvider: suspend () -> String,
        label: String = "12id wallet",
        logSink: LogSink? = null,
        minLogLevel: LogLevel = LogLevel.Info,
        idlePollInterval: Duration?,
    ) : this(apiBaseUrl, walletTokenProvider, label, logSink, minLogLevel) {
        this.idlePollInterval = idlePollInterval
    }
}

/** Log severity passed to a [LogSink]. */
public enum class LogLevel { Debug, Info, Warn, Error }

/** Destination for SDK log lines, e.g. a bridge to your own logger. */
public fun interface LogSink {
    public fun log(level: LogLevel, message: String, error: Throwable?)
}
