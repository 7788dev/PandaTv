package app.panda.tv.playback

import android.content.res.AssetManager
import app.panda.tv.model.Json

data class RuleCalibration(
    val health: HealthConfig,
    val buffer: BufferConfig,
    val budget: BudgetConfig,
    val alignment: AlignmentConfig,
)

object RuleCalibrationLoader {
    fun load(assets: AssetManager): RuleCalibration? = try {
        parse(assets.open("rule-calibration.json").bufferedReader(Charsets.UTF_8).use { it.readText() })
    } catch (_: Exception) {
        null
    }

    fun parse(text: String): RuleCalibration {
        val root = Json.parseObject(text)
        val health = Json.row(root["health"])
        val weights = Json.row(health["weights"])
        val healthConfig = HealthConfig(
            basisVersion = Json.text(health["basisVersion"]) ?: throw IllegalArgumentException("calibration:health"),
            decayVersion = Json.text(health["decayVersion"]) ?: throw IllegalArgumentException("calibration:health"),
            halfLifeDays = positive(health, "halfLifeDays"),
            baseline = number(health, "baseline"),
            slowStartupSec = positive(health, "slowStartupSec"),
            playFloorSec = positive(health, "playFloorSec"),
            workDeltaMax = positive(health, "workDeltaMax"),
            weights = HealthWeights(
                availability = number(weights, "availability"),
                stability = number(weights, "stability"),
                speed = number(weights, "speed"),
                quality = number(weights, "quality"),
            ),
        )
        require(
            healthConfig.weights.availability + healthConfig.weights.stability +
                healthConfig.weights.speed + healthConfig.weights.quality in 0.999..1.001
        ) { "calibration:health.weights" }

        val buffer = Json.row(root["buffer"])
        val bufferConfig = BufferConfig(
            startupTargetSec = positive(buffer, "startupTargetSec"),
            startupWindowSec = positive(buffer, "startupWindowSec"),
            playingLowSec = positive(buffer, "playingLowSec"),
            playingRiseWindowSec = positive(buffer, "playingRiseWindowSec"),
            seekLowSec = positive(buffer, "seekLowSec"),
            stallPositionSec = positive(buffer, "stallPositionSec"),
        )

        val budget = Json.row(root["budget"])
        val budgetConfig = BudgetConfig(
            maxSwitchesPerEpisode = integer(budget, "maxSwitchesPerEpisode"),
            minIntervalSec = positive(budget, "minIntervalSec"),
            failedSourceCooldownSec = positive(budget, "failedSourceCooldownSec"),
        )
        require(budgetConfig.maxSwitchesPerEpisode in 1..3) { "calibration:budget.maxSwitchesPerEpisode" }
        require(budgetConfig.minIntervalSec >= 30.0) { "calibration:budget.minIntervalSec" }
        require(budgetConfig.failedSourceCooldownSec >= 300.0) { "calibration:budget.failedSourceCooldownSec" }

        val alignment = Json.row(root["alignment"])
        val alignmentConfig = AlignmentConfig(
            basisVersion = Json.text(alignment["basisVersion"]) ?: throw IllegalArgumentException("calibration:alignment"),
            ratioTolerance = nonNegative(alignment, "ratioTolerance"),
            absoluteToleranceSec = nonNegative(alignment, "absoluteToleranceSec"),
            historyConsistencyRatio = nonNegative(alignment, "historyConsistencyRatio"),
            workSpreadFactor = nonNegative(alignment, "workSpreadFactor"),
            windowSeconds = positive(alignment, "windowSeconds"),
            sampleLimit = integer(alignment, "sampleLimit"),
            frameBudgetMs = integer(alignment, "frameBudgetMs").toLong(),
            similarityThreshold = number(alignment, "similarityThreshold"),
            offsetTtlDays = positive(alignment, "offsetTtlDays"),
            takeoverHeadroomFactor = positive(alignment, "takeoverHeadroomFactor"),
        )
        require(alignmentConfig.sampleLimit in 1..5) { "calibration:alignment.sampleLimit" }
        require(alignmentConfig.frameBudgetMs in 1..1_200L) { "calibration:alignment.frameBudgetMs" }

        return RuleCalibration(healthConfig, bufferConfig, budgetConfig, alignmentConfig)
    }

    private fun number(row: Map<String, Any?>, key: String): Double =
        (row[key] as? Number)?.toDouble()?.takeIf { it.isFinite() }
            ?: throw IllegalArgumentException("calibration:$key")

    private fun positive(row: Map<String, Any?>, key: String): Double =
        number(row, key).also { require(it > 0.0) { "calibration:$key" } }

    private fun nonNegative(row: Map<String, Any?>, key: String): Double =
        number(row, key).also { require(it >= 0.0) { "calibration:$key" } }

    private fun integer(row: Map<String, Any?>, key: String): Int {
        val value = number(row, key)
        require(value == value.toInt().toDouble()) { "calibration:$key" }
        return value.toInt()
    }
}