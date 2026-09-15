package com.onetwoid.sdk

/**
 * Configuration for [OneTwoId.initialize].
 *
 * @property apiBaseUrl the 12id platform API, e.g. `https://api.12id.com`.
 * @property walletTokenProvider returns this installation's wallet token. Your backend creates it with
 *   `POST /v1/wallets` (installation id as `Idempotency-Key`). The SDK asks again once when the platform
 *   rejects a token, because a retried `POST /v1/wallets` rotates it.
 * @property label the name issuers and verifiers see for this wallet. It is fixed at first onboarding;
 *   later changes are ignored because the wallet's storage is keyed by it.
 * @property logSink receives SDK and framework log lines; `null` logs nothing.
 */
public class OneTwoIdConfig(
    public val apiBaseUrl: String,
    public val walletTokenProvider: suspend () -> String,
    public val label: String = "12id wallet",
    public val logSink: LogSink? = null,
)

/** Log severity passed to a [LogSink]. */
public enum class LogLevel { Debug, Info, Warn, Error }

/** Destination for SDK log lines, e.g. a bridge to your own logger. */
public fun interface LogSink {
    public fun log(level: LogLevel, message: String, error: Throwable?)
}
