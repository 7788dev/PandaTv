package app.panda.tv.playback

import kotlin.math.abs

data class DurationInput(
    val fromSeconds: Double?,
    val fromSource: String,
    val toSeconds: Double?,
    val toSource: String,
)

data class DurationHistory(
    val sourceSamples: List<Double>,
    val workRatios: List<Double>,
)

data class DurationVerdict(
    val verdict: String,
    val measured: Boolean,
    val ratioDeviation: Double,
    val absDeviation: Double,
    val basisVersion: String,
    val reason: String?,
)

data class AlignmentConfig(
    val basisVersion: String,
    val ratioTolerance: Double,
    val absoluteToleranceSec: Double,
    val historyConsistencyRatio: Double,
    val workSpreadFactor: Double,
    val windowSeconds: Double,
    val sampleLimit: Int,
    val frameBudgetMs: Long,
    val similarityThreshold: Double,
    val offsetTtlDays: Double,
    val takeoverHeadroomFactor: Double,
)

data class FrameSample(val valid: Boolean, val hash: String)

data class ScoredSample(val offsetSeconds: Double, val similarity: Double, val valid: Boolean)

data class WindowSearchResult(val offset: Double?, val used: Int, val reason: String?)

object AlignmentRules {
    fun durationVerdict(
        input: DurationInput,
        history: DurationHistory,
        cfg: AlignmentConfig,
    ): DurationVerdict {
        if (missing(input)) {
            return DurationVerdict(
                verdict = "unknown",
                measured = false,
                ratioDeviation = 0.0,
                absDeviation = 0.0,
                basisVersion = cfg.basisVersion,
                reason = "duration-missing",
            )
        }
        val from = input.fromSeconds!!
        val to = input.toSeconds!!
        val absDeviation = abs(to - from)
        val ratioDeviation = absDeviation / maxOf(from, 1.0)
        val withinBasis = ratioDeviation <= cfg.ratioTolerance || absDeviation <= cfg.absoluteToleranceSec

        val samples = history.sourceSamples.filter { it.isFinite() && it > 0.0 }
        val sourceMedian = median(samples)
        val historyInconsistent = samples.size >= 2 &&
            sourceMedian > 0.0 &&
            (samples.max() - samples.min()) > cfg.historyConsistencyRatio * sourceMedian

        val peers = history.workRatios.filter { it.isFinite() && it >= 0.0 }
        val peerMedian = median(peers)
        val workOutlier = peers.size >= 3 &&
            (if (peerMedian > 0.0) ratioDeviation > cfg.workSpreadFactor * peerMedian
            else ratioDeviation > 0.0)

        if (historyInconsistent) {
            return DurationVerdict(
                "suspect", true, ratioDeviation, absDeviation, cfg.basisVersion, "history-inconsistent",
            )
        }
        if (workOutlier) {
            return DurationVerdict(
                "suspect", true, ratioDeviation, absDeviation, cfg.basisVersion, "work-outlier",
            )
        }
        return DurationVerdict(
            if (withinBasis) "consistent" else "suspect",
            true,
            ratioDeviation,
            absDeviation,
            cfg.basisVersion,
            null,
        )
    }

    fun pickOffsets(input: DurationInput, cfg: AlignmentConfig): List<Double> {
        if (missing(input)) return listOf(0.0)
        val delta = input.toSeconds!! - input.fromSeconds!!
        val candidates = ArrayList<Double>(3)
        for (value in listOf(0.0, delta, -delta)) {
            if (!value.isFinite()) continue
            if (candidates.none { abs(it - value) < 1e-6 }) candidates.add(value)
        }
        return candidates.sortedBy { abs(it) }.take(3)
    }

    fun similarity(a: FrameSample, b: FrameSample): Double {
        if (!a.valid || !b.valid) return 0.0
        if (a.hash.isEmpty() || a.hash.length != b.hash.length || a.hash.length % 2 != 0) return 0.0
        var distance = 0
        var index = 0
        while (index < a.hash.length) {
            val left = a.hash.substring(index, index + 2).toIntOrNull(16) ?: return 0.0
            val right = b.hash.substring(index, index + 2).toIntOrNull(16) ?: return 0.0
            distance += Integer.bitCount(left xor right)
            index += 2
        }
        val bits = (a.hash.length / 2) * 8
        return if (bits == 0) 0.0 else 1.0 - distance.toDouble() / bits
    }

    fun windowSearch(
        anchors: List<Double>,
        samples: List<ScoredSample>,
        elapsedMs: Long,
        cfg: AlignmentConfig,
    ): WindowSearchResult {
        if (elapsedMs > cfg.frameBudgetMs) return WindowSearchResult(null, 0, "over-budget")
        if (anchors.isEmpty()) return WindowSearchResult(null, 0, "no-match")

        val candidates = samples.filter { sample ->
            sample.valid &&
                sample.offsetSeconds.isFinite() &&
                sample.similarity.isFinite() &&
                anchors.any { abs(sample.offsetSeconds - it) <= cfg.windowSeconds }
        }
        if (candidates.size > cfg.sampleLimit) {
            return WindowSearchResult(null, candidates.size, "over-budget")
        }
        if (candidates.isEmpty()) return WindowSearchResult(null, 0, "no-match")

        val best = candidates.sortedWith(
            compareByDescending<ScoredSample> { it.similarity }.thenBy { abs(it.offsetSeconds) }
        ).first()
        if (best.similarity < cfg.similarityThreshold) {
            return WindowSearchResult(null, candidates.size, "no-match")
        }
        return WindowSearchResult(best.offsetSeconds, candidates.size, null)
    }

    private fun missing(input: DurationInput): Boolean =
        input.fromSource == "missing" ||
            input.toSource == "missing" ||
            input.fromSeconds == null ||
            input.toSeconds == null

    private fun median(values: List<Double>): Double {
        if (values.isEmpty()) return 0.0
        val sorted = values.sorted()
        val middle = sorted.size / 2
        return if (sorted.size % 2 == 0) {
            (sorted[middle - 1] + sorted[middle]) / 2.0
        } else {
            sorted[middle]
        }
    }
}