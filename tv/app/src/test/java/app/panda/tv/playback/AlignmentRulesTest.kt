package app.panda.tv.playback

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AlignmentRulesTest {
    private val cfg = AlignmentConfig(
        basisVersion = "test",
        ratioTolerance = 0.01,
        absoluteToleranceSec = 5.0,
        historyConsistencyRatio = 0.05,
        workSpreadFactor = 4.0,
        windowSeconds = 3.0,
        sampleLimit = 5,
        frameBudgetMs = 1_200,
        similarityThreshold = 0.9,
        offsetTtlDays = 7.0,
        takeoverHeadroomFactor = 1.5,
    )

    private fun input(from: Double?, to: Double?) = DurationInput(
        fromSeconds = from,
        fromSource = if (from == null) "missing" else "hls-extinf",
        toSeconds = to,
        toSource = if (to == null) "missing" else "hls-extinf",
    )

    @Test
    fun `a small deviation inside the basis is consistent`() {
        val verdict = AlignmentRules.durationVerdict(
            input(1200.0, 1205.0),
            DurationHistory(emptyList(), emptyList()),
            cfg,
        )
        assertEquals("consistent", verdict.verdict)
        assertTrue(verdict.measured)
    }

    @Test
    fun `zero from duration does not divide by zero`() {
        val verdict = AlignmentRules.durationVerdict(
            input(0.0, 0.5),
            DurationHistory(emptyList(), emptyList()),
            cfg,
        )
        assertTrue(verdict.ratioDeviation.isFinite())
        assertEquals(0.5, verdict.ratioDeviation, 1e-9)
    }

    @Test
    fun `one historical sample cannot contradict itself`() {
        val verdict = AlignmentRules.durationVerdict(
            input(1200.0, 1205.0),
            DurationHistory(listOf(1500.0), emptyList()),
            cfg,
        )
        assertEquals("consistent", verdict.verdict)
    }

    @Test
    fun `offsets ignore duplicate candidates`() {
        assertEquals(listOf(0.0), AlignmentRules.pickOffsets(input(1200.0, 1200.0), cfg))
        assertEquals(listOf(0.0, 5.0, -5.0), AlignmentRules.pickOffsets(input(1200.0, 1205.0), cfg))
    }

    @Test
    fun `similarity rejects malformed hashes`() {
        val valid = FrameSample(true, "ffffffffffffffff")
        assertEquals(0.0, AlignmentRules.similarity(valid, FrameSample(true, "fff")), 1e-9)
        assertEquals(0.0, AlignmentRules.similarity(valid, FrameSample(false, "ffffffffffffffff")), 1e-9)
    }

    @Test
    fun `window search ignores samples outside every anchor`() {
        val result = AlignmentRules.windowSearch(
            listOf(0.0),
            listOf(ScoredSample(10.0, 1.0, true)),
            100,
            cfg,
        )
        assertNull(result.offset)
        assertEquals("no-match", result.reason)
        assertEquals(0, result.used)
    }
}