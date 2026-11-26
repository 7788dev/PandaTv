package app.panda.tv.playback

import app.panda.tv.model.Copy
import app.panda.tv.model.Json
import app.panda.tv.net.PublicResponse
import app.panda.tv.state.SourceHealthStore
import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicInteger

class TvRecoveryTest {
    private fun health(): SourceHealthStore {
        val cfg = RuleCalibrationLoader.parse(File("src/main/assets/rule-calibration.json").readText())
        val target = File.createTempFile("panda-recovery", ".json").apply { deleteOnExit() }
        return SourceHealthStore(target, cfg.health, cfg.budget)
    }

    private fun media(open: suspend (String) -> PublicResponse) = object : MediaFetcher {
        override suspend fun text(url: String): Pair<String, String> = error("Unexpected manifest")
        override suspend fun open(url: String, headers: Map<String, String>) = open(url)
    }

    @Test fun userRetryReopensTheOnlyWorkingSource() = runBlocking {
        val rules = admissionRules(listOf("only"))
        val calls = AtomicInteger()
        var offline = false
        val service = PlaybackService(rules, WarmMediaCache(rules), admissionCatalogue(), health = health(),
            mediaFetcher = media { url ->
                calls.incrementAndGet()
                if (offline) error("temporary media outage")
                admissionResponse(url).first
            })
        val playing = service.resolve(admissionMovie, 1)
        offline = true
        val auto = runCatching { service.resolve(admissionMovie, 1, retry = true, retryFailureKind = FailureKind.STALL, switchingFrom = playing) }
        assertTrue(auto.isFailure)
        val before = calls.get()
        assertEquals(2, before)
        offline = false
        assertEquals("only", service.resolve(admissionMovie, 1, retry = true, userRetry = true).sourceKey)
        assertEquals(before + 1, calls.get())
    }

    @Test fun dismissingPlayerDoesNotPoisonAnotherWork() = runBlocking {
        val rules = admissionRules(listOf("only"))
        val started = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val store = health()
        val service = PlaybackService(rules, WarmMediaCache(rules), admissionCatalogue(), turnMs = 20, health = store,
            mediaFetcher = media { url -> started.complete(Unit); release.await(); admissionResponse(url).first })
        val first = async { service.resolve(admissionMovie, 1) }
        withTimeout(2000) { started.await() }
        delay(45)
        first.cancelAndJoin()
        release.complete(Unit)
        assertFalse(store.rankFor("only", "db-55").cooled)
        assertEquals("only", service.resolve(admissionMovie.copy(id = "db-55"), 1).sourceKey)
    }

    @Test fun retryInsideDirectoryCooldownKeepsTheOriginalDeadline() = runBlocking {
        val rules = admissionRules(listOf("only"))
        var now = 60_000L
        val calls = AtomicInteger()
        val cat = admissionCatalogue()
        val p = PlaybackService(rules, WarmMediaCache(rules), CatalogueFetcher { url, ms ->
            if (calls.incrementAndGet() <= 3) error("temporary failure")
            cat.getJson(url, ms)
        }, requeryDelayMs = 1, catalogueClock = { now })
        repeat(2) { assertTrue(runCatching { p.prepareItem(admissionMovie, 1) }.isFailure) }
        assertEquals(3, calls.get())
        now += 16_000
        assertTrue(runCatching { p.prepareItem(admissionMovie, 1) }.isFailure)
        assertEquals(3, calls.get())
        now += 15_500
        assertEquals(admissionMovie.id, p.prepareItem(admissionMovie, 1).id)
        assertEquals(4, calls.get())
    }

    @Test fun blockedDirectoryIoCannotHoldAdmissionPastBothDeadlines() = runBlocking {
        val rules = admissionRules(listOf("only"))
        val hold = CountDownLatch(1)
        val calls = AtomicInteger()
        val p = PlaybackService(rules, WarmMediaCache(rules), CatalogueFetcher { _, _ ->
            calls.incrementAndGet()
            hold.await()
            """{"list":[]}"""
        }, requeryDelayMs = 5, catalogueTimeoutMs = 100)
        try {
            val result = withTimeout(1800) { runCatching { p.prepareItem(admissionMovie, 1) } }
            assertEquals(Copy.Extra.UNAVAILABLE, result.exceptionOrNull()?.message)
            assertEquals(2, calls.get())
        } finally { hold.countDown() }
    }

    @Test fun laterDirectoryUpdatesEpisodesAndSourcesWithoutAnotherLookup() = runBlocking {
        val rules = admissionRules(listOf("early", "late"))
        val late = CompletableDeferred<Unit>()
        val calls = AtomicInteger()
        val p = PlaybackService(rules, WarmMediaCache(rules), CatalogueFetcher { url, _ ->
            calls.incrementAndGet()
            val n = if (url.contains("late.catalog")) { late.await(); 5 } else 1
            val eps = (1..n).joinToString("#") { "第" + it + "集\$https://media.example.org/" + it + ".mp4" }
            Json.stringify(mapOf("list" to listOf(mapOf("vod_id" to 1, "vod_name" to admissionSerial.title,
                "vod_year" to "2023", "type_name" to "电视剧", "vod_play_from" to "mp4", "vod_play_url" to eps))))
        }, searchGraceMs = 20)
        assertNull(p.availability(admissionSerial).episodes)
        assertEquals(1, p.sources(admissionSerial, 1).list.size)
        val final = async { p.availability(admissionSerial, complete = true) }
        val requestedEpisode = async { p.prepareItem(admissionSerial, 5) }
        late.complete(Unit)
        assertEquals(5, withTimeout(1000) { final.await() }.episodes)
        assertEquals(5, requestedEpisode.await().episodes)
        assertEquals(2, p.sources(admissionSerial, 1, complete = true).list.size)
        assertEquals(2, calls.get())
    }

    @Test fun adBearingEditionIsExcludedBeforeCandidateLimit() = runBlocking {
        val shipped = SourceRulesLoader.validate(File("src/main/assets/play-sources.json").readText())
        val hongniu = shipped.sources.single { it.key == "hongniu" }
        assertTrue("71759" in hongniu.excludedRecordIds)
        val rules = shipped.copy(sources = listOf(hongniu))
        val fetch = CatalogueFetcher { _, _ ->
            val rows = listOf("71759", "71759", "71759", "71759", "99").map { id ->
                mapOf("vod_id" to id, "vod_name" to admissionMovie.title, "vod_year" to "2023", "type_name" to "电影",
                    "vod_play_url" to "正片\$https://media.example.org/$id.mp4", "vod_play_from" to "mp4")
            }
            Json.stringify(mapOf("list" to rows))
        }
        val requests = mutableListOf<String>()
        val p = PlaybackService(rules, WarmMediaCache(rules), fetch,
            mediaFetcher = media { url -> requests.add(url); admissionResponse(url).first })
        assertEquals("https://media.example.org/99.mp4", p.resolve(admissionMovie, 1).url)
        assertEquals(listOf("https://media.example.org/99.mp4"), requests)
    }
}
