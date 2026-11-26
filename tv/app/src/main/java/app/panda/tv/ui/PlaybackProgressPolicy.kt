package app.panda.tv.ui

internal data class PlaybackProgressSample(val positionMs: Long, val advancedAtMs: Long)

internal object PlaybackProgressPolicy {
    const val STALL_TIMEOUT_MS = 20_000L
    private const val MIN_PROGRESS_MS = 80L
    private const val SEEK_RESET_MS = 1_000L

    fun observe(positionMs: Long, nowMs: Long, previous: PlaybackProgressSample, monitoring: Boolean = true): PlaybackProgressSample {
        val position = positionMs.coerceAtLeast(0L)
        if (!monitoring) return PlaybackProgressSample(position, nowMs)
        val delta = position - previous.positionMs
        return when {
            delta >= MIN_PROGRESS_MS || delta <= -SEEK_RESET_MS -> PlaybackProgressSample(position, nowMs)
            delta < 0L -> previous.copy(positionMs = position)
            else -> previous
        }
    }

    fun needsBufferRecovery(
        reason: String?,
        buffering: Boolean,
        alternatives: Boolean,
        sinceProgressMs: Long,
        refillWindowSec: Double,
    ): Boolean = when (reason) {
        "stalled" -> true
        "low-buffer" -> buffering && alternatives && sinceProgressMs >= refillWindowSec * 1000.0
        else -> false
    }

    fun isStalled(nowMs: Long, sample: PlaybackProgressSample): Boolean =
        nowMs - sample.advancedAtMs >= STALL_TIMEOUT_MS
}
