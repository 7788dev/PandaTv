package app.panda.tv.playback

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SwitchBudgetRulesTest {
    private val at = 1_000_000L

    private val cfg = BudgetConfig(
        maxSwitchesPerEpisode = 3,
        minIntervalSec = 30.0,
        failedSourceCooldownSec = 300.0,
    )

    @Test
    fun `empty history allows a switch`() {
        assertEquals(SwitchDecision(true, null, 0), SwitchBudgetRules.evaluateSwitch(emptyList(), at, cfg))
    }

    @Test
    fun `exactly the interval allows a switch`() {
        val events = listOf(SwitchEvent(at - 30_000, "auto"))
        assertTrue(SwitchBudgetRules.evaluateSwitch(events, at, cfg).allowed)
        val tooSoon = listOf(SwitchEvent(at - 29_999, "auto"))
        assertEquals("interval", SwitchBudgetRules.evaluateSwitch(tooSoon, at, cfg).reason)
    }

    @Test
    fun `manual picks never consume the automatic budget`() {
        val events = List(5) { SwitchEvent(at - it * 1_000L, "manual") }
        assertEquals(SwitchDecision(true, null, 0), SwitchBudgetRules.evaluateSwitch(events, at, cfg))
    }

    @Test
    fun `attempts equal to the limit are denied`() {
        val events = List(3) { SwitchEvent(at - 60_000L - it * 1_000L, "auto") }
        val decision = SwitchBudgetRules.evaluateSwitch(events, at, cfg)
        assertFalse(decision.allowed)
        assertEquals("limit", decision.reason)
        assertEquals(3, decision.attempts)
    }

    @Test
    fun `unavailable mark expires at the deadline`() {
        val mark = SwitchBudgetRules.markUnavailableOnce("b", at, cfg)
        assertTrue(SwitchBudgetRules.isUnavailable(mark, at + 299_999))
        assertFalse(SwitchBudgetRules.isUnavailable(mark, at + 300_000))
    }
}