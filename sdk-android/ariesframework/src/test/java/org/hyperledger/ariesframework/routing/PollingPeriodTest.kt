package org.hyperledger.ariesframework.routing

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** 12id fork change (F9): an interval of 0 or less disables the framework's pickup timer. */
class PollingPeriodTest {
    @Test
    fun positiveIntervalKeepsTheTimer() {
        assertEquals(10_000L, pollingPeriodMillis(10))
        assertEquals(1_000L, pollingPeriodMillis(1))
    }

    @Test
    fun zeroOrLessDisablesIt() {
        assertNull(pollingPeriodMillis(0))
        assertNull(pollingPeriodMillis(-1))
    }
}
