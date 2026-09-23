@file:Suppress("unused")

package org.slf4j.impl

import com.onetwoid.sdk.LogLevel
import com.onetwoid.sdk.internal.SdkLog
import org.slf4j.ILoggerFactory
import org.slf4j.IMarkerFactory
import org.slf4j.Logger
import org.slf4j.helpers.BasicMarkerFactory
import org.slf4j.helpers.MarkerIgnoringBase
import org.slf4j.helpers.MessageFormatter
import org.slf4j.helpers.NOPMDCAdapter
import org.slf4j.spi.LoggerFactoryBinder
import org.slf4j.spi.MDCAdapter
import org.slf4j.spi.MarkerFactoryBinder
import java.util.concurrent.ConcurrentHashMap

/**
 * slf4j 1.7 binding that hands the framework's log lines to the SDK's [com.onetwoid.sdk.LogSink].
 * Without a binding the framework is silent, and every stall across the mediator becomes guesswork
 * (4-init trap 16). These classes are public because slf4j loads them by name; they are not part of
 * the SDK's API. An app that ships its own slf4j binding wins or loses the classpath race with this
 * one; slf4j prints which it picked.
 *
 * Lines below `OneTwoIdConfig.minLogLevel` are dropped here and in [SdkLog] (review M14): the
 * framework's debug lines carry proof-request contents and connection records.
 */
public class StaticLoggerBinder private constructor() : LoggerFactoryBinder {
    private val factory = SinkLoggerFactory()

    override fun getLoggerFactory(): ILoggerFactory = factory

    override fun getLoggerFactoryClassStr(): String = SinkLoggerFactory::class.java.name

    public companion object {
        private val singleton: StaticLoggerBinder = StaticLoggerBinder()

        @JvmStatic
        public fun getSingleton(): StaticLoggerBinder = singleton

        /** Read by slf4j reflectively (1.7.x). */
        @JvmField
        public var REQUESTED_API_VERSION: String = "1.7.32"
    }
}

public class StaticMDCBinder private constructor() {
    public fun getMDCA(): MDCAdapter = NOPMDCAdapter()

    public fun getMDCAdapterClassStr(): String = NOPMDCAdapter::class.java.name

    public companion object {
        @JvmField
        public val SINGLETON: StaticMDCBinder = StaticMDCBinder()

        @JvmStatic
        public fun getSingleton(): StaticMDCBinder = SINGLETON
    }
}

public class StaticMarkerBinder private constructor() : MarkerFactoryBinder {
    private val markerFactory = BasicMarkerFactory()

    override fun getMarkerFactory(): IMarkerFactory = markerFactory

    override fun getMarkerFactoryClassStr(): String = BasicMarkerFactory::class.java.name

    public companion object {
        @JvmField
        public val SINGLETON: StaticMarkerBinder = StaticMarkerBinder()

        @JvmStatic
        public fun getSingleton(): StaticMarkerBinder = SINGLETON
    }
}

internal class SinkLoggerFactory : ILoggerFactory {
    private val loggers = ConcurrentHashMap<String, Logger>()

    override fun getLogger(name: String): Logger = loggers.getOrPut(name) { SinkLogger(name) }
}

internal class SinkLogger(private val loggerName: String) : MarkerIgnoringBase() {
    private val tag = loggerName.substringAfterLast('.')

    private fun emit(level: LogLevel, message: String?, error: Throwable?) {
        SdkLog.log(level, "[$tag] ${message.orEmpty()}", error)
    }

    private fun emit(level: LogLevel, format: String?, vararg args: Any?) {
        val tuple = MessageFormatter.arrayFormat(format, args)
        emit(level, tuple.message, tuple.throwable)
    }

    override fun getName(): String = loggerName

    override fun isTraceEnabled(): Boolean = false
    override fun trace(msg: String?) = Unit
    override fun trace(format: String?, arg: Any?) = Unit
    override fun trace(format: String?, arg1: Any?, arg2: Any?) = Unit
    override fun trace(format: String?, vararg arguments: Any?) = Unit
    override fun trace(msg: String?, t: Throwable?) = Unit

    override fun isDebugEnabled(): Boolean = SdkLog.enabled(LogLevel.Debug)
    override fun debug(msg: String?) = emit(LogLevel.Debug, msg, null)
    override fun debug(format: String?, arg: Any?) = emit(LogLevel.Debug, format, arg)
    override fun debug(format: String?, arg1: Any?, arg2: Any?) = emit(LogLevel.Debug, format, arg1, arg2)
    override fun debug(format: String?, vararg arguments: Any?) = emit(LogLevel.Debug, format, *arguments)
    override fun debug(msg: String?, t: Throwable?) = emit(LogLevel.Debug, msg, t)

    override fun isInfoEnabled(): Boolean = SdkLog.enabled(LogLevel.Info)
    override fun info(msg: String?) = emit(LogLevel.Info, msg, null)
    override fun info(format: String?, arg: Any?) = emit(LogLevel.Info, format, arg)
    override fun info(format: String?, arg1: Any?, arg2: Any?) = emit(LogLevel.Info, format, arg1, arg2)
    override fun info(format: String?, vararg arguments: Any?) = emit(LogLevel.Info, format, *arguments)
    override fun info(msg: String?, t: Throwable?) = emit(LogLevel.Info, msg, t)

    override fun isWarnEnabled(): Boolean = SdkLog.enabled(LogLevel.Warn)
    override fun warn(msg: String?) = emit(LogLevel.Warn, msg, null)
    override fun warn(format: String?, arg: Any?) = emit(LogLevel.Warn, format, arg)
    override fun warn(format: String?, vararg arguments: Any?) = emit(LogLevel.Warn, format, *arguments)
    override fun warn(format: String?, arg1: Any?, arg2: Any?) = emit(LogLevel.Warn, format, arg1, arg2)
    override fun warn(msg: String?, t: Throwable?) = emit(LogLevel.Warn, msg, t)

    override fun isErrorEnabled(): Boolean = SdkLog.enabled(LogLevel.Error)
    override fun error(msg: String?) = emit(LogLevel.Error, msg, null)
    override fun error(format: String?, arg: Any?) = emit(LogLevel.Error, format, arg)
    override fun error(format: String?, arg1: Any?, arg2: Any?) = emit(LogLevel.Error, format, arg1, arg2)
    override fun error(format: String?, vararg arguments: Any?) = emit(LogLevel.Error, format, *arguments)
    override fun error(msg: String?, t: Throwable?) = emit(LogLevel.Error, msg, t)
}
