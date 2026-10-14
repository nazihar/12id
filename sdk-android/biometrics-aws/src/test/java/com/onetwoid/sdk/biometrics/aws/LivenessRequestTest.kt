package com.onetwoid.sdk.biometrics.aws

import com.onetwoid.sdk.OneTwoIdException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class LivenessRequestTest {
    private val credentials = """{"accessKeyId":"ASIA","secretAccessKey":"s","sessionToken":"t","expiration":"2026-10-14T10:15:00.000Z"}"""

    @Test
    fun `a platform without liveness options means the AWS defaults`() {
        val request = LivenessRequest.parse("""{"sessionId":"sess-1","region":"ap-south-1","credentials":$credentials}""")
        assertEquals("sess-1", request.sessionId)
        assertEquals("ap-south-1", request.region)
        assertEquals(1_791_972_900L, request.expirationEpochSeconds)
        assertFalse(request.skipStartScreen)
        assertFalse(request.backCamera)
    }

    @Test
    fun `reads the tenant's start screen and camera`() {
        val request = LivenessRequest.parse("""{"sessionId":"s","region":"ap-south-1","startScreen":"skip","camera":"back","credentials":$credentials}""")
        assertTrue(request.skipStartScreen)
        assertTrue(request.backCamera)

        val defaults = LivenessRequest.parse("""{"sessionId":"s","region":"ap-south-1","startScreen":"show","camera":"front","credentials":$credentials}""")
        assertFalse(defaults.skipStartScreen)
        assertFalse(defaults.backCamera)
    }

    @Test
    fun `a configuration without credentials is an internal error`() {
        assertThrows(OneTwoIdException.Internal::class.java) { LivenessRequest.parse("""{"sessionId":"s","region":"ap-south-1"}""") }
    }
}
