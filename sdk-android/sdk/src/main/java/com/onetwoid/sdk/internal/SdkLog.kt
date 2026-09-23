package com.onetwoid.sdk.internal

import com.onetwoid.sdk.LogLevel
import com.onetwoid.sdk.LogSink

/** The one place SDK and framework log lines go; `OneTwoId.initialize` installs the customer's sink. */
internal object SdkLog {
    @Volatile var sink: LogSink? = null

    /** Set from `OneTwoIdConfig.minLogLevel`; nothing below it reaches the sink (review M14). */
    @Volatile var minLevel: LogLevel = LogLevel.Info

    /** Whether a line at this level would be delivered; also answers slf4j's `is*Enabled`. */
    fun enabled(level: LogLevel): Boolean = sink != null && level.ordinal >= minLevel.ordinal

    fun log(level: LogLevel, message: String, error: Throwable? = null) {
        if (!enabled(level)) return
        sink?.log(level, message, error)
    }

    fun debug(message: String) = log(LogLevel.Debug, message)
    fun info(message: String) = log(LogLevel.Info, message)
    fun warn(message: String, error: Throwable? = null) = log(LogLevel.Warn, message, error)
    fun error(message: String, error: Throwable? = null) = log(LogLevel.Error, message, error)
}
