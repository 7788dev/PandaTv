package app.panda.tv.playback

import app.panda.tv.model.Quality
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HealthRulesTest {
    private val at = 1_760_000_000_000L

    private val cfg = HealthConfig(
        basisVersion = "test",
        decayVersion = "1",
        halfLifeDays = 30.0,
        baseline = 0.5,
        slowStartupSec = 6.0,
        playFloorSec = 60.0,
        workDeltaMax = 0.2,
        weights = HealthWeights(0.4, 0.3, 0.2, 0.1),
    )

    private fun entry(
        success: Int = 0,
        failure: FailureCounts = FailureCounts(),
        playSeconds: Double = 0.0,
        stallSeconds: Double = 0.0,
        scoredAt: Long = at,
        cooldownUntil: Long? = null,
    ) = HealthEntry(
        sourceKey = "a",
        success = success,
        failure = failure,
        startupMedian = null,
        startupWorst = null,
        playSeconds = playSeconds,
        stallSeconds = stallSeconds,
        shownQuality = Quality.Q1080P,
        lastSuccessAt = null,
        lastFailureAt = null,
        lastFailureKind = null,
        score = 0.0,
        scoredAt = scoredAt,
        decayVersion = "1",
        cooldownUntil = cooldownUntil,
        lastAlignmentDegrade = null,
    )

    @Test
    fun `zero play seconds with a stall stays finite`() {
        val score = HealthRules.scoreOf(entry(playSeconds = 0.0, stallSeconds = 30.0), at, cfg)
        assertTrue(score.isFinite())
        assertTrue(score in 0.0..1.0)
    }

    @Test
    fun `empty history lands inside the score range`() {
        val score = HealthRules.scoreOf(entry(), at, cfg)
        assertTrue(score.isFinite())
        assertTrue(score in 0.0..1.0)
    }

    @Test
    fun `cooldown expires exactly at its deadline`() {
        assertFalse(HealthRules.verdictOf(entry(cooldownUntil = at), at, cfg).cooled)
        assertTrue(HealthRules.verdictOf(entry(cooldownUntil = at + 1), at, cfg).cooled)
    }

    @Test
    fun `one failure does not zero a healthy source`() {
        val failure = FailureCounts(probe = 1)
        val score = HealthRules.scoreOf(entry(success = 20, failure = failure), at, cfg)
        assertTrue(score > 0.5)
    }

    @Test
    fun `failure records a kind without mutating the input`() {
        val base = entry(success = 3)
        val next = HealthRules.withFailure(base, FailureKind.FIRST_SEGMENT, at, cfg, 300.0)
        assertEquals(0, base.failure.firstSegment)
        assertEquals(1, next.failure.firstSegment)
        assertEquals(at + 300_000L, next.cooldownUntil)
    }
}