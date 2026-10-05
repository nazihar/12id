package com.onetwoid.sdk.internal

import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.filterIsInstance
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull
import org.hyperledger.ariesframework.agent.AgentEvents
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds

/** The two pickup operations the delivery schedule needs; [PickupRunner] in the app, a fake in tests. */
internal interface Pickups {
    /** One batch pickup; the number of messages it delivered, or null when no batch came back in time. */
    suspend fun batch(reason: String): Int?

    /** Batches until one comes back empty (true), or until [timeout] or a failed batch (false). */
    suspend fun drain(reason: String, timeout: Duration): Boolean
}

/**
 * Sends every mediator pickup the SDK makes (windows, foreground drain, sync, idle), one at a time.
 * The framework publishes `PickupEvent(messageCount)` after each batch (fork change F4) and swallows a
 * failed send, so a batch that never answers counts as failed after [batchTimeout].
 */
internal class PickupRunner(
    private val send: suspend () -> Unit,
    private val events: Flow<Any>,
    private val batchTimeout: Duration = 15.seconds,
) : Pickups {
    private val mutex = Mutex()

    override suspend fun batch(reason: String): Int? = mutex.withLock { batchLocked(reason) }

    override suspend fun drain(reason: String, timeout: Duration): Boolean = mutex.withLock {
        withTimeoutOrNull(timeout) {
            var count = batchLocked(reason)
            while (count != null && count > 0) count = batchLocked(reason)
            count == 0
        } ?: false
    }

    private suspend fun batchLocked(reason: String): Int? = coroutineScope {
        // Rare by design (4-init §2.7.3, on-demand delivery), so one line per pickup is affordable at Info.
        SdkLog.info("mediator pickup ($reason)")
        // Subscribe before asking, or a fast batch reply is missed (the bus has no replay).
        val next = async(start = CoroutineStart.UNDISPATCHED) {
            withTimeoutOrNull(batchTimeout) { events.filterIsInstance<AgentEvents.PickupEvent>().first().messageCount }
        }
        send()
        next.await()
    }
}
