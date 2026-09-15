package com.onetwoid.sdk.internal

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class SdkStoreTest {
    @get:Rule
    val tmp = TemporaryFolder()

    @Test
    fun `an empty directory reads as the default state`() {
        assertEquals(SdkState(), SdkStore(File(tmp.root, "state")).read())
    }

    @Test
    fun `update persists across instances`() {
        val dir = File(tmp.root, "state")
        SdkStore(dir).update { it.copy(label = "wallet", mediatorInvitationUrl = "https://m/invitation") }
        SdkStore(dir).update { it.copy(genesisSha256 = "abc") }

        assertEquals(
            SdkState(label = "wallet", mediatorInvitationUrl = "https://m/invitation", genesisSha256 = "abc"),
            SdkStore(dir).read(),
        )
    }

    @Test
    fun `unknown keys from a newer SDK are ignored`() {
        val dir = File(tmp.root, "state").apply { mkdirs() }
        File(dir, "state.json").writeText("""{"label":"w","somethingNew":1}""")

        assertEquals(SdkState(label = "w"), SdkStore(dir).read())
    }

    @Test
    fun `clear removes the directory`() {
        val dir = File(tmp.root, "state")
        SdkStore(dir).write(SdkState(label = "w"))
        SdkStore(dir).clear()

        assertFalse(dir.exists())
    }
}
