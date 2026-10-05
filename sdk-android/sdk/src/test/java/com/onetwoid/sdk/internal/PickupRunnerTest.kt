package com.onetwoid.sdk.internal

import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.test.runTest
import org.hyperledger.ariesframework.agent.AgentEvents
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.time.Duration.Companion.seconds

/** The SDK's only path to the mediator: one pickup at a time, answered by the framework's PickupEvent (F4). */
class PickupRunnerTest {
    /** Like the framework over HTTP: the batch is processed, and its event published, inside send(). */
    private class FakeMediator {
        val bus = MutableSharedFlow<Any>()
        val queue = ArrayDeque<Int>()
        var inFlight = 0
        var maxInFlight = 0
        var sends = 0
        var silent = false

        suspend fun send() {
            sends++
            inFlight++
            maxInFlight = maxOf(maxInFlight, inFlight)
            delay(100)
            inFlight--
            // A failed send is swallowed by the framework: nothing is published.
            if (!silent) bus.emit(AgentEvents.PickupEvent(queue.removeFirstOrNull() ?: 0))
        }
    }

    private fun runner(mediator: FakeMediator) = PickupRunner(send = mediator::send, events = mediator.bus, batchTimeout = 15.seconds)

    @Test
    fun `a batch returns the number of messages it delivered`() = runTest {
        val mediator = FakeMediator().apply { queue.add(3) }
        assertEquals(3, runner(mediator).batch("window"))
    }

    @Test
    fun `a batch that never answers counts as failed`() = runTest {
        val mediator = FakeMediator().apply { silent = true }
        assertNull(runner(mediator).batch("window"))
        // The wait starts before the send (subscribe first), so it ends 15 s after the call.
        assertEquals(15_000L, testScheduler.currentTime)
    }

    @Test
    fun `drain asks until a batch comes back empty`() = runTest {
        val mediator = FakeMediator().apply { queue.addAll(listOf(10, 10, 4)) }
        assertTrue(runner(mediator).drain("sync", 20.seconds))
        assertEquals(4, mediator.sends)
    }

    @Test
    fun `drain stops at a failed batch`() = runTest {
        val mediator = FakeMediator().apply { silent = true }
        assertFalse(runner(mediator).drain("sync", 60.seconds))
        assertEquals(1, mediator.sends)
    }

    @Test
    fun `drain gives up at its timeout`() = runTest {
        val mediator = FakeMediator().apply { repeat(1_000) { queue.add(10) } }
        assertFalse(runner(mediator).drain("sync", 1.seconds))
    }

    @Test
    fun `concurrent callers never overlap at the mediator`() = runTest {
        val mediator = FakeMediator()
        val pickups = runner(mediator)
        listOf(
            async { pickups.batch("window") },
            async { pickups.drain("foreground", 20.seconds) },
            async { pickups.batch("tail") },
            async { pickups.drain("sync", 20.seconds) },
        ).awaitAll()
        assertEquals(1, mediator.maxInFlight)
        assertEquals(4, mediator.sends)
    }
}
