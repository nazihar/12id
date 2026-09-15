package com.onetwoid.sdk.internal

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.File

/** What the SDK must remember between launches. Lives in noBackupFilesDir (never in Auto Backup). */
@Serializable
internal data class SdkState(
    /** Base64 of the Keystore-wrapped Askar wallet key. */
    val wrappedWalletKey: String? = null,
    /** The label the wallet was onboarded with; the framework keys its storage by it. */
    val label: String? = null,
    /** The single-use mediator invitation this wallet mediated through; passed unchanged on every launch. */
    val mediatorInvitationUrl: String? = null,
    /** sha256 of the cached genesis file in use. */
    val genesisSha256: String? = null,
)

/** Reads and atomically replaces the SDK state file. */
internal class SdkStore(val directory: File) {
    private val file = File(directory, "state.json")
    private val json = Json { ignoreUnknownKeys = true }

    fun read(): SdkState {
        if (!file.exists()) return SdkState()
        return json.decodeFromString(SdkState.serializer(), file.readText())
    }

    fun write(state: SdkState) {
        directory.mkdirs()
        val tmp = File(directory, "state.json.tmp")
        tmp.writeText(json.encodeToString(SdkState.serializer(), state))
        if (!tmp.renameTo(file)) {
            file.delete()
            check(tmp.renameTo(file)) { "cannot replace ${file.absolutePath}" }
        }
    }

    fun update(change: (SdkState) -> SdkState): SdkState = change(read()).also(::write)

    fun clear() {
        directory.deleteRecursively()
    }
}
