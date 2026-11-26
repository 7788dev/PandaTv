package app.panda.tv.playback

data class BufferSample(val at: Long, val ahead: Double, val position: Double, val bufferedToEnd: Boolean = false)

data class BufferConfig(
    val startupTargetSec: Double,
    val startupWindowSec: Double,
    val playingLowSec: Double,
    val playingRiseWindowSec: Double,
    val seekLowSec: Double,
    val stallPositionSec: Double,
)

data class TakeoverVerdict(
    val takeOver: Boolean,
    val reason: String?,
    val threshold: Double,
    val ahead: Double,
    val riseSlope: Double?,
)

object BufferRules {
    fun thresholdOf(scene: String, cfg: BufferConfig): Double = when (scene) {
        "startup" -> cfg.startupTargetSec
        "seek" -> cfg.seekLowSec
        else -> cfg.playingLowSec
    }

    fun shouldTakeOver(
        scene: String,
        samples: List<BufferSample>,
        cfg: BufferConfig,
    ): TakeoverVerdict {
        val threshold = thresholdOf(scene, cfg)
        if (samples.isEmpty()) {
            return TakeoverVerdict(false, null, threshold, 0.0, null)
        }
        val last = samples.last()
        val ahead = last.ahead
        val low = !last.bufferedToEnd && ahead < threshold
        if (scene == "startup") {
            val elapsedSec = (last.at - samples.first().at) / 1000.0
            val takeOver = elapsedSec >= cfg.startupWindowSec && low
            return TakeoverVerdict(takeOver, if (takeOver) "low-buffer" else null, threshold, ahead, null)
        }
        if (scene == "seek") {
            return if (low) {
                TakeoverVerdict(true, "low-buffer", threshold, ahead, null)
            } else {
                TakeoverVerdict(false, null, threshold, ahead, null)
            }
        }

        val riseStart = last.at - (cfg.playingRiseWindowSec * 1000).toLong()
        val inWindow = samples.filter { it.at >= riseStart }
        val first = inWindow.firstOrNull() ?: last
        val dtSec = (last.at - first.at) / 1000.0
        val riseSlope = if (inWindow.size >= 2 && dtSec > 0) {
            (last.ahead - first.ahead) / dtSec
        } else {
            null
        }

        val stallBefore = samples.filter { it.at <= last.at - (cfg.stallPositionSec * 1000).toLong() }
        val stallBase = stallBefore.lastOrNull()
        val stalled = stallBase != null && last.position <= stallBase.position

        val falling = riseSlope != null && riseSlope <= 0
        if (stalled) return TakeoverVerdict(true, "stalled", threshold, ahead, riseSlope)
        if (low && falling) return TakeoverVerdict(true, "low-buffer", threshold, ahead, riseSlope)
        return TakeoverVerdict(false, null, threshold, ahead, riseSlope)
    }
}
