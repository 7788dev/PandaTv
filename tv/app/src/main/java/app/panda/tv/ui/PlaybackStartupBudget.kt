package app.panda.tv.ui

/** Monotonic startup budget retained while a screen or playback intent is paused. */
internal class PlaybackStartupBudget(private var remainingMs: Long = 15_000L) {
    private var activeAtMs: Long? = null

    fun pause(nowMs: Long) {
        activeAtMs?.let { remainingMs = (remainingMs - (nowMs - it).coerceAtLeast(0L)).coerceAtLeast(0L) }
        activeAtMs = null
    }

    fun resume(nowMs: Long): Long {
        if (activeAtMs == null) activeAtMs = nowMs
        return remainingMs
    }

    fun finish() {
        remainingMs = 0L
        activeAtMs = null
    }
}
