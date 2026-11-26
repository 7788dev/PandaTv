package app.panda.tv.playback

data class SwitchEvent(val at: Long, val mode: String)

data class SwitchDecision(val allowed: Boolean, val reason: String?, val attempts: Int)

data class BudgetConfig(
    val maxSwitchesPerEpisode: Int,
    val minIntervalSec: Double,
    val failedSourceCooldownSec: Double,
)

data class UnavailableMark(val sourceKey: String, val until: Long)

object SwitchBudgetRules {
    fun evaluateSwitch(events: List<SwitchEvent>, at: Long, cfg: BudgetConfig): SwitchDecision {
        val auto = events.filter { it.mode == "auto" }
        val attempts = auto.size
        if (attempts >= cfg.maxSwitchesPerEpisode) {
            return SwitchDecision(allowed = false, reason = "limit", attempts = attempts)
        }
        if (auto.isNotEmpty()) {
            val last = auto.maxOf { it.at }
            if (at - last < (cfg.minIntervalSec * 1000).toLong()) {
                return SwitchDecision(allowed = false, reason = "interval", attempts = attempts)
            }
        }
        return SwitchDecision(allowed = true, reason = null, attempts = attempts)
    }

    fun markUnavailableOnce(sourceKey: String, at: Long, cfg: BudgetConfig): UnavailableMark =
        UnavailableMark(sourceKey, at + (cfg.failedSourceCooldownSec * 1000).toLong())

    fun isUnavailable(mark: UnavailableMark, at: Long): Boolean = mark.until > at
}