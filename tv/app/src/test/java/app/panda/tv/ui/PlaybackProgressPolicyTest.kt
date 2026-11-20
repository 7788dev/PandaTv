package app.panda.tv.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PlaybackProgressPolicyTest {
    @Test
    fun `playing without any timeline movement reaches the stall deadline`() {
        var sample = PlaybackProgressSample(positionMs = 0L, advancedAtMs = 0L)
        sample = PlaybackProgressPolicy.observe(positionMs = 0L, nowMs = 19_999L, previous = sample)
        assertFalse(PlaybackProgressPolicy.isStalled(19_999L, sample))

        sample = PlaybackProgressPolicy.observe(positionMs = 0L, nowMs = 20_000L, previous = sample)
        assertTrue(PlaybackProgressPolicy.isStalled(20_000L, sample))
    }

    @Test
    fun `ongoing low speed playback refreshes progress at its actual timeline rate`() {
        var sample = PlaybackProgressSample(positionMs = 0L, advancedAtMs = 0L)
        sample = PlaybackProgressPolicy.observe(positionMs = 100L, nowMs = 10_000L, previous = sample)
        assertEquals(10_000L, sample.advancedAtMs)
        assertFalse(PlaybackProgressPolicy.isStalled(29_999L, sample))

        sample = PlaybackProgressPolicy.observe(positionMs = 200L, nowMs = 20_000L, previous = sample)
        assertEquals(20_000L, sample.advancedAtMs)
    }

    @Test
    fun `seek rewind reanchors the watched position and timeout`() {
        val afterRewind = PlaybackProgressPolicy.observe(
            positionMs = 5_000L,
            nowMs = 42_000L,
            previous = PlaybackProgressSample(positionMs = 67_000L, advancedAtMs = 40_000L),
        )

        assertEquals(5_000L, afterRewind.positionMs)
        assertEquals(42_000L, afterRewind.advancedAtMs)
        assertFalse(PlaybackProgressPolicy.isStalled(61_999L, afterRewind))
    }
}
