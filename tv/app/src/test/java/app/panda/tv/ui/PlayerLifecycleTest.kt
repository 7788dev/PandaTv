package app.panda.tv.ui

import org.junit.Assert.*
import org.junit.Test

class PlayerLifecycleTest {
    @Test fun `a paused startup retains only its remaining active budget`() {
        val budget = PlaybackStartupBudget()
        assertEquals(15000L, budget.resume(1000L))
        budget.pause(5000L)
        assertEquals(11000L, budget.resume(125000L))
        budget.pause(128000L)
        budget.pause(228000L)
        assertEquals(8000L, budget.resume(328000L))
        budget.pause(336000L)
        assertEquals(0L, budget.resume(400000L))
    }
    @Test fun `a finished or replaced startup cannot retain an old deadline`() {
        val budget = PlaybackStartupBudget()
        budget.resume(0)
        budget.finish()
        assertEquals(0L, budget.resume(100000))
        assertEquals(15000L, PlaybackStartupBudget().resume(100000))
    }
    @Test fun `a long pause or hidden screen does not make resumed buffering an immediate stall`() {
        var sample = PlaybackProgressSample(30000, 1000)
        sample = PlaybackProgressPolicy.observe(30000, 121000, sample, monitoring = false)
        sample = PlaybackProgressPolicy.observe(30000, 121001, sample)
        assertFalse(PlaybackProgressPolicy.isStalled(131000, sample))
        assertTrue("An actual stalled resume must still time out", PlaybackProgressPolicy.isStalled(141000, sample))
        sample = PlaybackProgressPolicy.observe(30100, 141001, sample)
        assertFalse(PlaybackProgressPolicy.isStalled(141002, sample))
    }
}
