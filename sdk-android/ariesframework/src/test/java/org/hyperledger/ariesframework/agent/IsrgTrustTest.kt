package org.hyperledger.ariesframework.agent

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.X509TrustManager

// 12id fork change (F8): the embedded Let's Encrypt roots and the fallback order.
class IsrgTrustTest {
    @Test
    fun embeddedRootsAreTheLetsEncryptRoots() {
        val fingerprints = IsrgTrust.roots().associate { cert ->
            cert.subjectX500Principal.name to MessageDigest.getInstance("SHA-256").digest(cert.encoded)
                .joinToString(":") { "%02X".format(it) }
        }
        assertEquals(
            mapOf(
                "CN=ISRG Root X1,O=Internet Security Research Group,C=US" to "96:BC:EC:06:26:49:76:F3:74:60:77:9A:CF:28:C5:A7:CF:E8:A3:C0:AA:E1:1A:8F:FC:EE:05:C0:BD:DF:08:C6",
                "CN=ISRG Root X2,O=Internet Security Research Group,C=US" to "69:72:9B:8E:15:A8:6E:FC:17:7A:57:AF:B7:17:1D:FC:64:AD:D2:8C:2F:CA:8C:F1:50:7E:34:45:3C:CB:14:70",
                "CN=Root YE,O=ISRG,C=US" to "E1:4F:FC:AD:5B:00:25:73:10:06:CA:A4:3A:12:1A:22:D8:E9:70:0F:4F:B9:CF:85:2F:02:A7:08:AA:5D:56:66",
                "CN=Root YR,O=ISRG,C=US" to "E5:7B:7E:6F:15:0C:41:91:02:E8:D5:C0:55:72:9F:F9:67:B9:D1:A8:29:BF:00:CE:C8:9C:A6:04:EB:F4:A8:6F",
            ),
            fingerprints,
        )
        IsrgTrust.roots().forEach { it.verify(it.publicKey) } // self-signed roots
    }

    @Test
    fun theSystemDecidesFirst() {
        val roots = RecordingTrustManager(reject = false)
        IsrgTrust.FallbackTrustManager(RecordingTrustManager(reject = false), roots).checkServerTrusted(emptyArray(), "ECDHE_ECDSA")
        assertFalse(roots.called)
    }

    @Test
    fun theRootsAreTriedWhenTheSystemRejects() {
        val roots = RecordingTrustManager(reject = false)
        IsrgTrust.FallbackTrustManager(RecordingTrustManager(reject = true), roots).checkServerTrusted(emptyArray(), "ECDHE_ECDSA")
        assertTrue(roots.called)
    }

    @Test
    fun bothRejectingKeepsTheSystemError() {
        val system = RecordingTrustManager(reject = true)
        val roots = RecordingTrustManager(reject = true)
        try {
            IsrgTrust.FallbackTrustManager(system, roots).checkServerTrusted(emptyArray(), "ECDHE_ECDSA")
            fail("expected CertificateException")
        } catch (e: CertificateException) {
            assertSame(system.error, e)
            assertArrayEquals(arrayOf<Throwable>(roots.error), e.suppressed)
        }
    }

    private class RecordingTrustManager(private val reject: Boolean) : X509TrustManager {
        val error = CertificateException("rejected")
        var called = false
        override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
            called = true
            if (reject) throw error
        }
        override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) = Unit
        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
    }
}
