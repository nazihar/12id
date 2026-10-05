package com.onetwoid.sdk.internal

import com.onetwoid.sdk.WalletEvent
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.launch
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds

/**
 * When the wallet asks the mediator for messages (on-demand delivery, 2026-10-05). Nothing polls while
 * the app is idle: every message comes from something the customer's backend started, so either the app
 * knows a reply is coming (a window) or the backend relays `wallet.sync_requested` as a push (sync).
 *
 * - **Windows**: after `connect`, `acceptOffer` or `expectMessages`, poll every second for five polls,
 *   then every two seconds, until the expected event arrives or the window times out.
 * - **Foreground drain**: one drain each time the app comes to the foreground, for anything a missed
 *   push left queued.
 * - **Sync tail**: three polls in the 32 s after a sync. The platform sends at most one
 *   `wallet.sync_requested` per wallet per 30 s, so a message queued right after a push gets no push
 *   of its own; the tail collects it.
 * - **Idle polling**: only when the host app opted in with `OneTwoIdConfig.idlePollInterval`.
 */
internal class DeliveryScheduler(
    private val scope: CoroutineScope,
    private val pickups: Pickups,
    private val idlePollInterval: Duration? = null,
) {
    private class Window(val match: (WalletEvent) -> Boolean) {
        var deadline: Job? = null
    }

    private val lock = Any()
    private val windows = mutableListOf<Window>()
    private var fastPolls = 0
    private var loop: Job? = null
    private var tail: Job? = null
    private var foregroundDrain: Job? = null
    private var idle: Job? = null

    /** Polls until an event matching [match] arrives, or for at most [timeout]. */
    fun open(timeout: Duration, match: (WalletEvent) -> Boolean) {
        val window = Window(match)
        synchronized(lock) {
            windows += window
            // A new expectation starts fast again.
            fastPolls = 0
            window.deadline = scope.launch {
                delay(timeout)
                close(window)
            }
            if (loop?.isActive != true) loop = scope.launch { runWindows() }
        }
    }

    /** Ends every window waiting for [event]. Called for each event the wallet emits. */
    fun signal(event: WalletEvent) {
        val done = synchronized(lock) { windows.filter { it.match(event) }.also { windows.removeAll(it) } }
        done.forEach { it.deadline?.cancel() }
    }

    /** Starts (or restarts) the follow-up polls after a sync. */
    fun tail() {
        synchronized(lock) {
            tail?.cancel()
            tail = scope.launch {
                var elapsed = Duration.ZERO
                for (at in TAIL_POLLS) {
                    delay(at - elapsed)
                    elapsed = at
                    // A running window polls anyway.
                    if (!windowsOpen()) safely { pickups.drain("tail", DRAIN_TIMEOUT) }
                }
            }
        }
    }

    fun onForeground() {
        synchronized(lock) {
            if (foregroundDrain?.isActive != true) foregroundDrain = scope.launch { safely { pickups.drain("foreground", DRAIN_TIMEOUT) } }
            val interval = idlePollInterval
            if (interval != null && idle?.isActive != true) {
                idle = scope.launch {
                    while (true) {
                        delay(interval)
                        if (!windowsOpen()) safely { pickups.drain("idle", DRAIN_TIMEOUT) }
                    }
                }
            }
        }
    }

    /** Stops idle polling. Windows and the sync tail run to their end: they are short and were asked for. */
    fun onBackground() {
        synchronized(lock) {
            idle?.cancel()
            idle = null
        }
    }

    /** Returns when no window, sync tail or foreground drain is running. */
    suspend fun awaitIdle() {
        while (true) {
            val running = synchronized(lock) { listOfNotNull(loop, tail, foregroundDrain).filter { it.isActive } }
            if (running.isEmpty()) return
            running.joinAll()
        }
    }

    private suspend fun runWindows() {
        var immediate = false
        while (true) {
            val pause = synchronized(lock) {
                if (windows.isEmpty()) {
                    loop = null
                    return
                }
                when {
                    immediate -> Duration.ZERO
                    fastPolls++ < FAST_POLLS -> FAST_INTERVAL
                    else -> SLOW_INTERVAL
                }
            }
            delay(pause)
            if (!windowsOpen()) continue
            // A full batch means more is queued: ask again at once.
            immediate = safely { pickups.batch("window") } == FULL_BATCH
        }
    }

    private fun close(window: Window) {
        synchronized(lock) { windows.remove(window) }
    }

    private fun windowsOpen(): Boolean = synchronized(lock) { windows.isNotEmpty() }

    private suspend fun <T> safely(block: suspend () -> T): T? = try {
        block()
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        SdkLog.warn("mediator pickup failed", e)
        null
    }

    internal companion object {
        val FAST_INTERVAL = 1.seconds
        val SLOW_INTERVAL = 2.seconds
        const val FAST_POLLS = 5

        /** The batch size the framework asks for (`BatchPickupMessage(10)`). */
        const val FULL_BATCH = 10
        val TAIL_POLLS = listOf(10.seconds, 20.seconds, 32.seconds)
        val DRAIN_TIMEOUT = 20.seconds
    }
}
