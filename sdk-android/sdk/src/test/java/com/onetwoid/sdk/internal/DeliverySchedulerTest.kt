package com.onetwoid.sdk.internal

import com.onetwoid.sdk.WalletEvent
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds

/** On-demand delivery: when the wallet asks the mediator for messages (virtual time). */
@OptIn(ExperimentalCoroutinesApi::class)
class DeliverySchedulerTest {
    /** Records every pickup as (virtual ms, reason); batches answer from [counts], then 0. */
    private class FakePickups(private val scope: TestScope) : Pickups {
        val calls = mutableListOf<Pair<Long, String>>()
        val counts = ArrayDeque<Int>()
        var onBatch: (Int) -> Unit = {}

        override suspend fun batch(reason: String): Int {
            calls += scope.testScheduler.currentTime to reason
            val count = counts.removeFirstOrNull() ?: 0
            onBatch(calls.size)
            return count
        }

        override suspend fun drain(reason: String, timeout: Duration): Boolean {
            var count = batch(reason)
            while (count > 0) count = batch(reason)
            return true
        }

        fun times(reason: String) = calls.filter { it.second == reason }.map { it.first }
    }

    private fun TestScope.scheduler(pickups: Pickups, idle: Duration? = null) = DeliveryScheduler(backgroundScope, pickups, idle)

    private val offer = WalletEvent.OfferReceived("offer-1")

    /** Long enough for every window, drain and tail to finish. advanceUntilIdle ignores backgroundScope work. */
    private val RUN_OUT = 200_000L

    @Test
    fun `nothing polls while idle`() = runTest {
        val pickups = FakePickups(this)
        scheduler(pickups)
        advanceTimeBy(10 * 60_000L)
        assertTrue(pickups.calls.isEmpty())
    }

    @Test
    fun `a window polls every second five times, then every two seconds, until its timeout`() = runTest {
        val pickups = FakePickups(this)
        scheduler(pickups).open(15.seconds) { false }
        advanceTimeBy(RUN_OUT)
        assertEquals(listOf(1_000L, 2_000L, 3_000L, 4_000L, 5_000L, 7_000L, 9_000L, 11_000L, 13_000L), pickups.times("window"))
    }

    @Test
    fun `a window ends when its event arrives`() = runTest {
        val pickups = FakePickups(this)
        val delivery = scheduler(pickups)
        // The third pickup delivers the offer: the framework emits it before the batch returns.
        pickups.onBatch = { n -> if (n == 3) delivery.signal(offer) }
        delivery.open(30.seconds) { it is WalletEvent.OfferReceived }
        advanceTimeBy(RUN_OUT)
        assertEquals(3, pickups.calls.size)
    }

    @Test
    fun `an unrelated event leaves the window open`() = runTest {
        val pickups = FakePickups(this)
        val delivery = scheduler(pickups)
        pickups.onBatch = { n -> if (n == 1) delivery.signal(WalletEvent.ProofSent("p")) }
        delivery.open(4.seconds) { it == offer }
        advanceTimeBy(RUN_OUT)
        assertEquals(listOf(1_000L, 2_000L, 3_000L), pickups.times("window"))
    }

    @Test
    fun `a full batch is followed at once by another pickup`() = runTest {
        val pickups = FakePickups(this)
        pickups.counts.addAll(listOf(DeliveryScheduler.FULL_BATCH, 3))
        scheduler(pickups).open(2.5.seconds) { false }
        advanceTimeBy(RUN_OUT)
        assertEquals(listOf(1_000L, 1_000L, 2_000L), pickups.times("window"))
    }

    @Test
    fun `windows share one polling loop, and a new one starts fast again`() = runTest {
        val pickups = FakePickups(this)
        val delivery = scheduler(pickups)
        delivery.open(30.seconds) { it is WalletEvent.ConnectionCompleted }
        advanceTimeBy(8_500)
        // 1,2,3,4,5 then 7 — the slow phase.
        assertEquals(listOf(1_000L, 2_000L, 3_000L, 4_000L, 5_000L, 7_000L), pickups.times("window"))
        delivery.open(30.seconds) { it == offer }
        advanceTimeBy(1_000)
        delivery.signal(WalletEvent.ConnectionCompleted("c"))
        delivery.signal(offer)
        advanceTimeBy(RUN_OUT)
        // The loop's pending 2 s pause still ends at 9 s; the second window reset the cadence to 1 s.
        val times = pickups.times("window")
        assertEquals(listOf(1_000L, 2_000L, 3_000L, 4_000L, 5_000L, 7_000L, 9_000L), times)
    }

    @Test
    fun `coming to the foreground drains once`() = runTest {
        val pickups = FakePickups(this)
        pickups.counts.addAll(listOf(DeliveryScheduler.FULL_BATCH, 2))
        scheduler(pickups).onForeground()
        advanceTimeBy(RUN_OUT)
        assertEquals(listOf(0L, 0L, 0L), pickups.times("foreground"))
        assertEquals(3, pickups.calls.size)
    }

    @Test
    fun `the sync tail checks three times in the 32 seconds after a sync`() = runTest {
        val pickups = FakePickups(this)
        scheduler(pickups).tail()
        advanceTimeBy(RUN_OUT)
        assertEquals(listOf(10_000L, 20_000L, 32_000L), pickups.times("tail"))
    }

    @Test
    fun `a second sync restarts the tail`() = runTest {
        val pickups = FakePickups(this)
        val delivery = scheduler(pickups)
        delivery.tail()
        advanceTimeBy(15_000)
        delivery.tail()
        advanceTimeBy(RUN_OUT)
        assertEquals(listOf(10_000L, 25_000L, 35_000L, 47_000L), pickups.times("tail"))
    }

    @Test
    fun `the tail skips a check while a window is polling anyway`() = runTest {
        val pickups = FakePickups(this)
        val delivery = scheduler(pickups)
        delivery.tail()
        advanceTimeBy(9_500)
        delivery.open(5.seconds) { false }
        advanceTimeBy(RUN_OUT)
        assertEquals(listOf(20_000L, 32_000L), pickups.times("tail"))
    }

    @Test
    fun `idle polling runs only when configured, and only in the foreground`() = runTest {
        val pickups = FakePickups(this)
        val delivery = scheduler(pickups, idle = 15.seconds)
        advanceTimeBy(60_000)
        assertTrue("no idle poll before the app is in the foreground", pickups.calls.isEmpty())
        delivery.onForeground()
        advanceTimeBy(46_000)
        assertEquals(listOf(60_000L, 75_000L, 90_000L, 105_000L), pickups.calls.map { it.first })
        delivery.onBackground()
        advanceTimeBy(60_000)
        assertEquals(4, pickups.calls.size)
    }

    @Test
    fun `going to the background keeps a window running`() = runTest {
        val pickups = FakePickups(this)
        val delivery = scheduler(pickups)
        delivery.open(3.seconds) { false }
        delivery.onBackground()
        advanceTimeBy(RUN_OUT)
        assertEquals(listOf(1_000L, 2_000L), pickups.times("window"))
    }

    @Test
    fun `awaitIdle returns once the window and the tail are done`() = runTest {
        val pickups = FakePickups(this)
        val delivery = scheduler(pickups)
        delivery.open(5.seconds) { false }
        delivery.tail()
        var returnedAt = -1L
        launch {
            delivery.awaitIdle()
            returnedAt = testScheduler.currentTime
        }
        advanceTimeBy(RUN_OUT)
        assertEquals(32_000L, returnedAt)
    }

    @Test
    fun `awaitIdle returns at once when nothing runs`() = runTest {
        val delivery = scheduler(FakePickups(this))
        var returned = false
        launch {
            delivery.awaitIdle()
            returned = true
        }
        runCurrent()
        assertTrue(returned)
    }

    @Test
    fun `a failing pickup does not stop the window`() = runTest {
        var n = 0
        val failing = object : Pickups {
            override suspend fun batch(reason: String): Int {
                n++
                if (n == 1) throw IllegalStateException("mediator connection not ready")
                return 0
            }

            override suspend fun drain(reason: String, timeout: Duration) = true
        }
        scheduler(failing).open(3.seconds) { false }
        advanceTimeBy(RUN_OUT)
        assertEquals(2, n)
    }
}
