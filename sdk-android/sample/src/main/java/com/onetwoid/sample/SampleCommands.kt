package com.onetwoid.sample

import kotlinx.coroutines.flow.MutableSharedFlow

/** Commands the debug receiver sends to the foreground activity (a face check needs an activity). */
object SampleCommands {
    val verifyAll = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
}
