package com.onetwoid.sdk.internal

import com.onetwoid.sdk.LogLevel
import com.onetwoid.sdk.LogSink
import com.onetwoid.sdk.OneTwoIdException
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.slf4j.impl.StaticLoggerBinder

/** The log floor and the https-only base URL (review M14). */
class LoggingAndConfigTest {
    private val seen = mutableListOf<Pair<LogLevel, String>>()

    @After
    fun reset() {
        SdkLog.sink = null
        SdkLog.minLevel = LogLevel.Info
    }

    private fun collect(min: LogLevel) {
        SdkLog.sink = LogSink { level, message, _ -> seen += level to message }
        SdkLog.minLevel = min
    }

    @Test
    fun `a debug line does not reach a sink configured at Info`() {
        collect(LogLevel.Info)
        SdkLog.debug("Proof request json: {...}")
        SdkLog.info("wallet ready")
        SdkLog.error("boom")
        assertEquals(listOf(LogLevel.Info to "wallet ready", LogLevel.Error to "boom"), seen)
    }

    @Test
    fun `the framework binding is silent below the floor, and speaks above it`() {
        collect(LogLevel.Info)
        val logger = StaticLoggerBinder.getSingleton().loggerFactory.getLogger("org.hyperledger.ariesframework.proofs.ProofCommand")
        assertFalse("framework debug must not be enabled at Info", logger.isDebugEnabled)
        assertTrue(logger.isInfoEnabled)
        logger.debug("Proof request json: {\"requested_attributes\":{...}}")
        assertTrue("no debug line may reach the sink", seen.isEmpty())
        logger.warn("Pickup messages failed")
        assertEquals(listOf(LogLevel.Warn to "[ProofCommand] Pickup messages failed"), seen)
    }

    @Test
    fun `opting in to Debug delivers framework debug lines`() {
        collect(LogLevel.Debug)
        val logger = StaticLoggerBinder.getSingleton().loggerFactory.getLogger("x.y.ConnectionService")
        assertTrue(logger.isDebugEnabled)
        logger.debug("Connection record: {...}")
        assertEquals(1, seen.size)
    }

    @Test
    fun `without a sink nothing is enabled`() {
        SdkLog.minLevel = LogLevel.Debug
        assertFalse(SdkLog.enabled(LogLevel.Error))
    }

    @Test
    fun `the base URL must be https outside a debuggable build`() {
        checkApiBaseUrl("https://api.12id.com", debuggable = false)
        checkApiBaseUrl("http://10.0.2.2:3500", debuggable = true)
        for (url in listOf("http://api.12id.com", "ftp://api.12id.com", "api.12id.com", "")) {
            val error = runCatching { checkApiBaseUrl(url, debuggable = false) }.exceptionOrNull()
            assertTrue("expected a refusal for '$url', got $error", error is OneTwoIdException.InvalidConfiguration)
        }
        val release = runCatching { checkApiBaseUrl("http://api.12id.com", debuggable = false) }.exceptionOrNull()
        assertTrue(release!!.message!!.contains("debuggable"))
    }
}
