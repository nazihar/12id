package com.onetwoid.sdk.nativelibs

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import askar_uniffi.AskarStoreManager
import indy_vdr_uniffi.Ledger
import indy_vdr_uniffi.setProtocolVersion
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertTrue
import org.junit.Ignore
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * Loads each rebuilt library on the device and makes one real call into it, the way the fork does
 * (Wallet, AnoncredsService, LedgerService). UniFFI verifies its contract version and API checksums on
 * the first call, so this also proves the upstream bindings match the rebuilt libraries.
 * Needs no network: CI runs it on the x86_64 emulator matrix (4-init trap 42).
 */
@RunWith(AndroidJUnit4::class)
class NativeLibrariesTest {
    @Test
    fun askarGeneratesAStoreKey() {
        assertTrue(AskarStoreManager().generateRawStoreKey(null).isNotEmpty())
    }

    // Async UniFFI calls, on Dispatchers.IO like the SDK (OneTwoId.openSession); a hang fails after 60 s.
    // Ignored (W3, 2026-09-30): in this test APK the call never completes, with the upstream arm64
    // libraries exactly as with the rebuilt ones (API 24 and 36 emulators, ARM translation included), so
    // it is the harness, not the rebuild. The app path is covered by smoke:sdk-android.
    @Ignore("hangs with the upstream libraries too; see the comment above")
    @Test
    fun askarProvisionsAndOpensASqliteStore() = runBlocking(Dispatchers.IO) {
        withTimeout(60_000) {
            val dir = File(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir, "askar-test")
            dir.deleteRecursively()
            dir.mkdirs()
            val manager = AskarStoreManager()
            val key = manager.generateRawStoreKey(null)
            val store = manager.provision("sqlite://${dir.absolutePath}/sqlite.db", "raw", key, null, true)
            store.session(null)
            store.close()
            assertTrue(File(dir, "sqlite.db").exists())
        }
    }

    @Test
    fun anoncredsCreatesALinkSecret() {
        assertTrue(anoncreds_uniffi.createLinkSecret().isNotEmpty())
    }

    @Test
    fun indyVdrBuildsALedgerRequest() {
        setProtocolVersion(2)
        val request = Ledger().buildGetSchemaRequest(null, "Th7MpTaRZVRYnPiabds81Y:2:degree:1.0")
        assertTrue(request.body().contains("\"operation\""))
    }
}
