package app.panda.tv.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PlaybackSpeedPolicyTest {
    @Test
    fun `first buffering event waits for another event within the observation window`() {
        val first = PlaybackSpeedPolicy.observeBuffering(
            current = 2.0,
            requested = 2.0,
            previous = PlaybackBufferingSample(0L, 0),
            nowMs = 1_000L,
        )
        assertEquals(2.0, first.speed, 0.0)
        assertFalse(first.changed)
        assertEquals(PlaybackBufferingSample(1_000L, 1), first.sample)

        val afterWindow = PlaybackSpeedPolicy.observeBuffering(
            current = 2.0,
            requested = 2.0,
            previous = first.sample,
            nowMs = 1_000L + PlaybackSpeedPolicy.BUFFERING_WINDOW_MS,
        )
        assertEquals(2.0, afterWindow.speed, 0.0)
        assertEquals(1, afterWindow.sample.events)
    }

    @Test
    fun `reduces one speed step on repeated buffering without changing the requested speed`() {
        val first = PlaybackSpeedPolicy.observeBuffering(
            2.0, 2.0, PlaybackBufferingSample(0L, 0), 1_000L,
        )
        val decision = PlaybackSpeedPolicy.observeBuffering(2.0, 2.0, first.sample, 8_000L)

        assertEquals(1.5, decision.speed, 0.0)
        assertTrue(decision.changed)
        assertEquals(0, decision.sample.events)
    }

    @Test
    fun `buffering recovery backs off stepwise and never reduces slow or normal speeds`() {
        val first = PlaybackSpeedPolicy.observeBuffering(
            1.5, 2.0, PlaybackBufferingSample(1L, 0), 2L,
        )
        val second = PlaybackSpeedPolicy.observeBuffering(1.5, 2.0, first.sample, 3L)
        assertEquals(1.25, second.speed, 0.0)

        val third = PlaybackSpeedPolicy.observeBuffering(1.25, 2.0, second.sample, 4L)
        val fourth = PlaybackSpeedPolicy.observeBuffering(1.25, 2.0, third.sample, 5L)
        assertEquals(1.0, fourth.speed, 0.0)

        val normal = PlaybackSpeedPolicy.observeBuffering(1.0, 2.0, fourth.sample, 6L)
        assertEquals(1.0, normal.speed, 0.0)
        assertFalse(normal.changed)

        val slow = PlaybackSpeedPolicy.observeBuffering(0.75, 0.75, normal.sample, 7L)
        assertEquals(0.75, slow.speed, 0.0)
        assertFalse(slow.changed)
    }

    @Test
    fun `preserves normal speed and explicitly requested slow playback`() {
        assertEquals(1.0, PlaybackSpeedPolicy.evaluate(1.0, 2.0, 320, 80, 0, PlaybackSpeedPolicy.WINDOW_MS).speed, 0.0)
        assertEquals(0.75, PlaybackSpeedPolicy.evaluate(0.75, 0.75, 320, 80, 0, PlaybackSpeedPolicy.WINDOW_MS).speed, 0.0)
    }

    @Test
    fun `waits for a sufficiently sampled ten second window`() {
        val decision = PlaybackSpeedPolicy.evaluate(2.0, 2.0, rendered = 300, dropped = 20, cleanWindows = 0, elapsedMs = PlaybackSpeedPolicy.WINDOW_MS - 1)
        assertEquals(2.0, decision.speed, 0.0)
        assertFalse(decision.changed)
        assertEquals(2.0, PlaybackSpeedPolicy.evaluate(2.0, 2.0, 99, 20, 0, PlaybackSpeedPolicy.WINDOW_MS).speed, 0.0)
    }

    @Test
    fun `reduces one step after sustained dropped frames`() {
        val decision = PlaybackSpeedPolicy.evaluate(2.0, 2.0, rendered = 360, dropped = 40, cleanWindows = 0, elapsedMs = PlaybackSpeedPolicy.WINDOW_MS)
        assertEquals(1.5, decision.speed, 0.0)
        assertTrue(decision.changed)
    }

    @Test
    fun `restores one step after three clean windows without exceeding the request`() {
        assertEquals(1.5, PlaybackSpeedPolicy.evaluate(1.5, 2.0, 380, 4, 0, PlaybackSpeedPolicy.WINDOW_MS).speed, 0.0)
        assertEquals(1.5, PlaybackSpeedPolicy.evaluate(1.5, 2.0, 380, 4, 1, PlaybackSpeedPolicy.WINDOW_MS).speed, 0.0)
        val decision = PlaybackSpeedPolicy.evaluate(1.5, 2.0, 380, 4, 2, PlaybackSpeedPolicy.WINDOW_MS)
        assertEquals(2.0, decision.speed, 0.0)
        assertTrue(decision.changed)
    }

    @Test
    fun `restores after clean playback windows when public decoder callbacks have no samples`() {
        assertEquals(1.5, PlaybackSpeedPolicy.evaluate(1.5, 2.0, 0, 0, 0, PlaybackSpeedPolicy.WINDOW_MS).speed, 0.0)
        assertEquals(1.5, PlaybackSpeedPolicy.evaluate(1.5, 2.0, 0, 0, 1, PlaybackSpeedPolicy.WINDOW_MS).speed, 0.0)
        val decision = PlaybackSpeedPolicy.evaluate(1.5, 2.0, 0, 0, 2, PlaybackSpeedPolicy.WINDOW_MS)
        assertEquals(2.0, decision.speed, 0.0)
        assertTrue(decision.changed)
    }

    @Test
    fun `does not restore above the user requested speed`() {
        val decision = PlaybackSpeedPolicy.evaluate(1.5, 1.5, 400, 0, 3, PlaybackSpeedPolicy.WINDOW_MS)
        assertEquals(1.5, decision.speed, 0.0)
        assertFalse(decision.changed)
    }
}
