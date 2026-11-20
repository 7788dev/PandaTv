package app.panda.tv.ui

import app.panda.tv.model.Constants

internal data class PlaybackSpeedDecision(val speed: Double, val cleanWindows: Int, val changed: Boolean)
internal data class PlaybackBufferingSample(val windowStartedAtMs: Long, val events: Int)
internal data class PlaybackBufferingDecision(
    val speed: Double,
    val sample: PlaybackBufferingSample,
    val changed: Boolean,
)

internal object PlaybackSpeedPolicy {
    const val WINDOW_MS = 10_000L
    const val BUFFERING_WINDOW_MS = 45_000L
    const val BUFFERING_EVENTS_TO_REDUCE_SPEED = 2
    private const val MIN_WINDOW_FRAMES = 120
    private const val MIN_DROPPED_FRAMES = 8
    private const val REDUCE_RATIO = 0.10
    private const val RESTORE_RATIO = 0.02
    private const val CLEAN_WINDOWS_TO_RESTORE = 3

    fun observeBuffering(
        current: Double,
        requested: Double,
        previous: PlaybackBufferingSample,
        nowMs: Long,
    ): PlaybackBufferingDecision {
        if (current <= 1.0 || requested <= 1.0) {
            return PlaybackBufferingDecision(current, PlaybackBufferingSample(0L, 0), false)
        }

        val inWindow = previous.events > 0 && nowMs >= previous.windowStartedAtMs &&
            nowMs - previous.windowStartedAtMs < BUFFERING_WINDOW_MS
        val windowStartedAtMs = if (inWindow) previous.windowStartedAtMs else nowMs
        val events = if (inWindow) previous.events + 1 else 1
        if (events < BUFFERING_EVENTS_TO_REDUCE_SPEED) {
            return PlaybackBufferingDecision(current, PlaybackBufferingSample(windowStartedAtMs, events), false)
        }

        val currentIndex = Constants.SPEEDS.indexOf(current)
        val nextSpeed = if (currentIndex > 0) Constants.SPEEDS[currentIndex - 1] else 1.0
        val changed = currentIndex > 0 && nextSpeed < current
        return PlaybackBufferingDecision(
            if (changed) nextSpeed else current,
            PlaybackBufferingSample(nowMs, 0),
            changed,
        )
    }

    fun evaluate(current: Double, requested: Double, rendered: Int, dropped: Int, cleanWindows: Int, elapsedMs: Long): PlaybackSpeedDecision {
        val total = rendered + dropped
        if (elapsedMs < WINDOW_MS || dropped < 0 || rendered < 0) {
            return PlaybackSpeedDecision(current, 0, false)
        }
        val speeds = Constants.SPEEDS
        val currentIndex = speeds.indexOf(current)
        if (currentIndex < 0) return PlaybackSpeedDecision(current, 0, false)
        if (total < MIN_WINDOW_FRAMES) {
            return if (rendered == 0 && dropped == 0) {
                restoreAfterCleanWindow(current, requested, cleanWindows + 1, currentIndex)
            } else {
                PlaybackSpeedDecision(current, 0, false)
            }
        }
        val dropRatio = dropped.toDouble() / total
        if (dropped >= MIN_DROPPED_FRAMES && dropRatio >= REDUCE_RATIO && current > 1.0) {
            return PlaybackSpeedDecision(speeds[currentIndex - 1], 0, true)
        }
        val nextCleanWindows = if (dropRatio <= RESTORE_RATIO) cleanWindows + 1 else 0
        if (nextCleanWindows == 0) return PlaybackSpeedDecision(current, 0, false)
        return restoreAfterCleanWindow(current, requested, nextCleanWindows, currentIndex)
    }

    private fun restoreAfterCleanWindow(current: Double, requested: Double, cleanWindows: Int, currentIndex: Int): PlaybackSpeedDecision {
        if (cleanWindows >= CLEAN_WINDOWS_TO_RESTORE && current < requested) {
            val requestedIndex = Constants.SPEEDS.indexOf(requested).takeIf { it >= 0 } ?: currentIndex
            return PlaybackSpeedDecision(Constants.SPEEDS[minOf(currentIndex + 1, requestedIndex)], 0, currentIndex < requestedIndex)
        }
        return PlaybackSpeedDecision(current, cleanWindows, false)
    }
}
