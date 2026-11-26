package app.panda.tv.playback

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BufferRulesTest {
    private val cfg = BufferConfig(
        startupTargetSec = 4.0,
        startupWindowSec = 3.0,
        playingLowSec = 6.0,
        playingRiseWindowSec = 5.0,
        seekLowSec = 3.0,
        stallPositionSec = 20.0,
    )

    @Test
    fun `empty samples never take over`() {
        val verdict = BufferRules.shouldTakeOver("playing", emptyList(), cfg)
        assertFalse(verdict.takeOver)
        assertEquals(0.0, verdict.ahead, 1e-9)
    }

    @Test
    fun `startup ignores a low buffer`() {
        val samples = listOf(BufferSample(0, 0.0, 0.0), BufferSample(1_000, 0.0, 0.0))
        assertFalse(BufferRules.shouldTakeOver("startup", samples, cfg).takeOver)
    }

    @Test
    fun `startup switches only when the target stays low for the complete window`() {
        val low = listOf(BufferSample(0, 1.0, 0.0), BufferSample(3_000, 2.0, 0.0))
        assertTrue(BufferRules.shouldTakeOver("startup", low, cfg).takeOver)
        val recovered = listOf(BufferSample(0, 1.0, 0.0), BufferSample(3_000, 4.0, 0.0))
        assertFalse(BufferRules.shouldTakeOver("startup", recovered, cfg).takeOver)
    }

    @Test
    fun `seek treats the threshold as inclusive`() {
        assertFalse(BufferRules.shouldTakeOver("seek", listOf(BufferSample(0, 3.0, 10.0)), cfg).takeOver)
        assertTrue(BufferRules.shouldTakeOver("seek", listOf(BufferSample(0, 2.9, 10.0)), cfg).takeOver)
    }

    @Test
    fun `playing needs a falling slope as well as a low buffer`() {
        val single = listOf(BufferSample(0, 1.0, 10.0))
        assertFalse(BufferRules.shouldTakeOver("playing", single, cfg).takeOver)
        assertNull(BufferRules.shouldTakeOver("playing", single, cfg).riseSlope)
    }

    @Test
    fun `stall window boundary is respected`() {
        val justBefore = listOf(
            BufferSample(0, 20.0, 100.0),
            BufferSample(19_999, 20.0, 100.0),
        )
        assertFalse(BufferRules.shouldTakeOver("playing", justBefore, cfg).takeOver)
        val atWindow = listOf(
            BufferSample(0, 20.0, 100.0),
            BufferSample(20_000, 20.0, 100.0),
        )
        assertTrue(BufferRules.shouldTakeOver("playing", atWindow, cfg).takeOver)
    }
}
