package app.panda.tv.playback

import app.panda.tv.model.Quality
import kotlin.math.max
import kotlin.math.pow

enum class FailureKind(val wire: String) {
    CATALOGUE("catalogue"),
    PROBE("probe"),
    FIRST_SEGMENT("first-segment"),
    STALL("stall"),
    ALIGNMENT("alignment");

    companion object {
        fun fromWire(value: String?): FailureKind? = values().firstOrNull { it.wire == value }
    }
}

data class FailureCounts(
    val catalogue: Int = 0,
    val probe: Int = 0,
    val firstSegment: Int = 0,
    val stall: Int = 0,
    val alignment: Int = 0,
) {
    fun total(): Int = catalogue + probe + firstSegment + stall + alignment

    fun plus(kind: FailureKind): FailureCounts = when (kind) {
        FailureKind.CATALOGUE -> copy(catalogue = catalogue + 1)
        FailureKind.PROBE -> copy(probe = probe + 1)
        FailureKind.FIRST_SEGMENT -> copy(firstSegment = firstSegment + 1)
        FailureKind.STALL -> copy(stall = stall + 1)
        FailureKind.ALIGNMENT -> copy(alignment = alignment + 1)
    }
}

data class HealthEntry(
    val sourceKey: String,
    val success: Int,
    val failure: FailureCounts,
    val startupMedian: Double?,
    val startupWorst: Double?,
    val playSeconds: Double,
    val stallSeconds: Double,
    val shownQuality: Quality?,
    val lastSuccessAt: Long?,
    val lastFailureAt: Long?,
    val lastFailureKind: FailureKind?,
    val score: Double,
    val scoredAt: Long,
    val decayVersion: String,
    val cooldownUntil: Long?,
    val lastAlignmentDegrade: String?,
)

data class HealthWeights(
    val availability: Double,
    val stability: Double,
    val speed: Double,
    val quality: Double,
)

data class HealthConfig(
    val basisVersion: String,
    val decayVersion: String,
    val halfLifeDays: Double,
    val baseline: Double,
    val slowStartupSec: Double,
    val playFloorSec: Double,
    val workDeltaMax: Double,
    val weights: HealthWeights,
)

data class HealthVerdict(val cooled: Boolean, val rank: Double)

object HealthRules {
    private const val DAY_MS = 86_400_000.0

    fun scoreOf(entry: HealthEntry, at: Long, cfg: HealthConfig): Double {
        val ageDays = max(0.0, (at - entry.scoredAt).toDouble()) / DAY_MS
        val decay = 0.5.pow(ageDays / cfg.halfLifeDays)
        val availability = (entry.success + 1).toDouble() /
            (entry.success + entry.failure.total() + 2).toDouble()
        val stability = 1.0 - clamp01(entry.stallSeconds / max(entry.playSeconds, cfg.playFloorSec))
        val speed = entry.startupMedian?.let { 1.0 - clamp01(it / cfg.slowStartupSec) } ?: 0.5
        val quality = entry.shownQuality?.let { it.rank / 4.0 } ?: 0.5
        val raw = clamp01(
            cfg.weights.availability * availability +
                cfg.weights.stability * stability +
                cfg.weights.speed * speed +
                cfg.weights.quality * quality
        )
        return clamp01(decay * raw + (1 - decay) * cfg.baseline)
    }

    fun compareRank(a: HealthVerdict, b: HealthVerdict): Int {
        val cooled = (if (a.cooled) 1 else 0) - (if (b.cooled) 1 else 0)
        if (cooled != 0) return cooled
        return b.rank.compareTo(a.rank)
    }

    fun verdictOf(entry: HealthEntry, at: Long, cfg: HealthConfig): HealthVerdict {
        val cooled = entry.cooldownUntil != null && entry.cooldownUntil > at
        return HealthVerdict(cooled = cooled, rank = if (cooled) -1.0 else scoreOf(entry, at, cfg))
    }

    fun withFailure(
        entry: HealthEntry,
        kind: FailureKind,
        at: Long,
        cfg: HealthConfig,
        cooldownSec: Double,
    ): HealthEntry {
        val next = entry.copy(
            failure = entry.failure.plus(kind),
            lastFailureAt = at,
            lastFailureKind = kind,
            cooldownUntil = at + (cooldownSec * 1000).toLong(),
        )
        return next.copy(score = scoreOf(next, at, cfg), scoredAt = at)
    }

    fun withoutCooldown(entry: HealthEntry, at: Long, cfg: HealthConfig): HealthEntry =
        entry.copy(cooldownUntil = null, score = scoreOf(entry, at, cfg), scoredAt = at)

    private fun clamp01(value: Double): Double {
        if (!value.isFinite()) return 0.0
        return value.coerceIn(0.0, 1.0)
    }
}