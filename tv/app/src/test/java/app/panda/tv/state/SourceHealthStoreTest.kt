package app.panda.tv.state

import app.panda.tv.playback.BudgetConfig
import app.panda.tv.playback.FailureKind
import app.panda.tv.playback.HealthConfig
import app.panda.tv.playback.HealthWeights
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

class SourceHealthStoreTest {
    private val at = 1_760_000_000_000L

    private val cfg = HealthConfig(
        basisVersion = "test",
        decayVersion = "1",
        halfLifeDays = 30.0,
        baseline = 0.5,
        slowStartupSec = 8.0,
        playFloorSec = 60.0,
        workDeltaMax = 0.2,
        weights = HealthWeights(0.4, 0.3, 0.2, 0.1),
    )

    private val budget = BudgetConfig(3, 30.0, 300.0)

    private fun directory(): File = Files.createTempDirectory("panda-tv-health").toFile()

    @Test
    fun `cooldown survives a restart`() {
        val dir = directory()
        try {
            val path = File(dir, "source-health-v1.json")
            val first = SourceHealthStore(path, cfg, budget, clock = { at })
            first.recordFailure("ffzy", FailureKind.STALL, "db-1", 1, at)
            first.flush()
            val second = SourceHealthStore(path, cfg, budget, clock = { at + 1_000 })
            assertTrue(second.rankFor("ffzy", "db-1").cooled)
            second.flush()
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun `a successful source outranks a failing one`() {
        val dir = directory()
        try {
            val store = SourceHealthStore(File(dir, "health.json"), cfg, budget, clock = { at })
            store.recordSuccess("a", "db-1", 1, at)
            repeat(3) { store.recordFailure("b", FailureKind.STALL, "db-1", 1, at) }
            assertTrue(store.rankFor("a", "db-1").rank > store.rankFor("b", "db-1").rank)
            store.flush()
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun `live stalling lowers the rank`() {
        val dir = directory()
        try {
            val store = SourceHealthStore(File(dir, "health.json"), cfg, budget, clock = { at })
            store.recordSuccess("a", "db-1", 1, at)
            val before = store.rankFor("a", "db-1").rank
            store.updateLive("a", playSeconds = 60.0, stallSeconds = 30.0)
            assertTrue(store.rankFor("a", "db-1").rank < before)
            store.flush()
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun `flush persists live statistics exactly once`() {
        val dir = directory()
        try {
            val path = File(dir, "health.json")
            val store = SourceHealthStore(path, cfg, budget, clock = { at })
            store.recordSuccess("a", "db-1", 1, at)
            store.updateLive("a", playSeconds = 600.0, stallSeconds = 300.0)
            val before = store.snapshot()
            store.flush()
            store.flush()
            assertEquals(before, store.snapshot())
            assertEquals(before, SourceHealthStore(path, cfg, budget, clock = { at }).snapshot())

            store.updateLive("a", playSeconds = 60.0, stallSeconds = 10.0)
            store.flush()
            val reopened = SourceHealthStore(path, cfg, budget, clock = { at })
            assertEquals(store.snapshot(), reopened.snapshot())
            assertEquals(660.0, reopened.snapshot().globals.single().playSeconds, 1e-9)
            assertEquals(310.0, reopened.snapshot().globals.single().stallSeconds, 1e-9)
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun `live statistics survive a failed write and are saved on retry`() {
        val dir = directory()
        try {
            val blocked = File(dir, "blocked").apply { writeText("not a directory") }
            val path = File(blocked, "health.json")
            val store = SourceHealthStore(path, cfg, budget, clock = { at })
            store.recordSuccess("a", "db-1", 1, at)
            store.updateLive("a", playSeconds = 60.0, stallSeconds = 30.0)
            store.flush()
            blocked.delete()
            store.flush()

            val reopened = SourceHealthStore(path, cfg, budget, clock = { at })
            assertEquals(60.0, reopened.snapshot().globals.single().playSeconds, 1e-9)
            assertEquals(30.0, reopened.snapshot().globals.single().stallSeconds, 1e-9)
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun `corrupt archive falls back to empty and keeps a backup`() {
        val dir = directory()
        try {
            val path = File(dir, "source-health-v1.json")
            path.writeText("{not json")
            val store = SourceHealthStore(path, cfg, budget, clock = { at })
            assertTrue(store.snapshot().globals.isEmpty())
            assertTrue(File(dir, "source-health-v1.json.bak").exists())
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun `unsupported version stays untouched`() {
        val dir = directory()
        try {
            val path = File(dir, "source-health-v1.json")
            val original = "{\"version\":2,\"globals\":[],\"works\":[]}"
            path.writeText(original)
            val store = SourceHealthStore(path, cfg, budget, clock = { at })
            assertTrue(store.snapshot().globals.isEmpty())
            assertEquals(original, path.readText())
            assertTrue(dir.listFiles().orEmpty().any { it.name.startsWith("source-health-v1.json.unsupported-") })
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun `an impossible path does not throw out of flush`() {
        val dir = directory()
        try {
            val blocked = File(dir, "blocked")
            blocked.writeText("not a directory")
            val store = SourceHealthStore(File(blocked, "health.json"), cfg, budget, clock = { at })
            store.recordSuccess("a", "db-1", 1, at)
            store.flush()
            assertFalse(File(blocked, "health.json").exists())
        } finally {
            dir.deleteRecursively()
        }
    }
}
