package app.panda.tv.playback

import app.panda.tv.data.*
import app.panda.tv.model.*
import app.panda.tv.net.PublicResponse
import app.panda.tv.state.SourceHealthStore
import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.net.URLDecoder
import java.util.Collections
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicBoolean

class AuditProbeTest {
    private val cfg = RuleCalibrationLoader.parse(File("src/main/assets/rule-calibration.json").readText())
    private fun health() = SourceHealthStore(File.createTempFile("panda-tv-audit-health", ".json").apply { delete(); deleteOnExit() }, cfg.health, cfg.budget)
    private fun media(handle: suspend (String) -> PublicResponse) = object : MediaFetcher {
        override suspend fun text(url: String): Pair<String, String> = error("unexpected manifest")
        override suspend fun open(url: String, headers: Map<String, String>) = handle(url)
    }
    private fun metadata(delayRanks: Boolean, missMovies: Boolean, served: AtomicInteger = AtomicInteger()): DoubanDataSource {
        return DoubanDataSource(fetcher = MetadataFetcher { url, _ ->
            val u = URLDecoder.decode(url, "UTF-8")
            val chart = u.contains("subject_collection/")
            val rank = chart && !u.contains("movie_latest")
            if (rank && delayRanks) delay(800)
            if (missMovies && u.contains("movie_latest")) return@MetadataFetcher HttpReply(404, "{}")
            val kind = if (u.contains("/movie/") || u.contains("movie_latest") || u.contains("movie_real_time")) "movie" else "tv"
            val genre = when {
                u.contains("综艺") -> "真人秀"
                u.contains("动画") || u.contains("tv_animation") -> "动画"
                u.contains("纪录片") -> "纪录片"
                else -> "剧情"
            }
            val id = (u.hashCode().toLong() + 2147483648).toString()
            val row = mapOf("id" to id, "title" to "电影$id", "type" to kind, "genres" to listOf(genre),
                "cover_url" to "https://img1.doubanio.com/view/poster.jpg", "year" to "2023")
            if (u.contains("电视剧")) served.incrementAndGet()
            HttpReply(200, Json.stringify(mapOf((if (chart) "subject_collection_items" else "items") to listOf(row), "total" to 1, "count" to 1)))
        }, homeRetryMs = emptyList())
    }
    @Test fun coldHomeUpdateOrder() = runBlocking {
        val updates = Collections.synchronizedList(mutableListOf<List<String>>())
        val returned = metadata(true, false).home { updates.add(it.shelves.map { s -> s.id }) }.shelves.map { it.id }
        println("coldHome updates=$updates returned=$returned")
        assertTrue(updates.any { it.size > returned.size })
        assertTrue("hot-tv" in returned)
    }
    @Test fun coldHomeSingleGroupFailure() = runBlocking {
        val served = AtomicInteger()
        val answer = runCatching { metadata(false, true, served).home() }
        println("coldHomeSingleFailure servedTV=$served error=" + answer.exceptionOrNull()?.message)
        assertTrue(answer.isFailure)
        assertTrue(served.get() > 0)
    }
    @Test fun retryAtErrorPageAfterTransientMediaFailure() = runBlocking {
        val store = health()
        val opens = AtomicInteger()
        val rules = admissionRules(listOf("only"))
        val p = PlaybackService(rules, WarmMediaCache(rules), admissionCatalogue(), health=store, mediaFetcher=media { url ->
            opens.incrementAndGet()
            admissionResponse(url).first
        })
        val active = p.resolve(admissionMovie,1)
        val auto = runCatching { p.resolve(admissionMovie,1,retry=true,retryFailureKind=FailureKind.STALL,switchingFrom=active) }
        val before=opens.get()
        val click = runCatching { p.resolve(admissionMovie,1,retry=true) }
        val diff=opens.get()-before
        val pick = p.resolve(admissionMovie,1,from="only")
        println("retry autoError=" + auto.exceptionOrNull()?.message + " buttonError=" + click.exceptionOrNull()?.message + " newMediaRequests=$diff explicitPick=" + pick.sourceKey)
        assertTrue(auto.isFailure && click.isFailure)
        assertEquals(0,diff)
        assertEquals("only",pick.sourceKey)
    }
    @Test fun backingOutOfSlowProbeCoolsHealthySource() = runBlocking {
        val store = health()
        val rules = admissionRules(listOf("only"))
        val started = CompletableDeferred<Unit>()
        val unblock = CompletableDeferred<Unit>()
        val opens=AtomicInteger()
        val p = PlaybackService(rules, WarmMediaCache(rules), admissionCatalogue(), health=store, mediaFetcher=media { url ->
            opens.incrementAndGet(); started.complete(Unit); unblock.await(); admissionResponse(url).first
        })
        val load=async { p.resolve(admissionMovie,1) }
        withTimeout(5000) { started.await() }
        delay(2700)
        load.cancelAndJoin()
        unblock.complete(Unit)
        val snapshot = store.snapshot().globals.single()
        val before=opens.get()
        val otherWork=admissionMovie.copy(id="db-4242")
        val another=runCatching { p.resolve(otherWork,1) }
        println("cancelSlowProbe cooled=" + snapshot.cooled + " kind=" + snapshot.lastFailureKind + " anotherWorkError=" + another.exceptionOrNull()?.message + " anotherWorkOpens=" + (opens.get()-before))
        assertTrue(snapshot.cooled && another.isFailure)
        assertEquals(before,opens.get())
    }
    @Test fun laterCatalogueIsInvisibleInInitialSnapshots() = runBlocking {
        val rules = admissionRules(listOf("early","late"))
        val release = CompletableDeferred<Unit>()
        val catalogue = CatalogueFetcher { url, _ ->
            val late = url.contains("late.catalog")
            if (late) release.await()
            val eps=(1..(if(late) 5 else 1)).joinToString("#") { "第" + it + "集\$https://public.example.org/" + it + ".mp4" }
            Json.stringify(mapOf("list" to listOf(mapOf("vod_id" to "1","vod_name" to admissionSerial.title,"vod_year" to "2023",
                "type_name" to "电视剧","vod_play_from" to "mp4","vod_play_url" to eps)),"pagecount" to 1))
        }
        val p = PlaybackService(rules,WarmMediaCache(rules),catalogue,searchGraceMs=40)
        val earlyAvailability = p.availability(admissionSerial).episodes
        val earlyLines = p.sources(admissionSerial,1).list.size
        release.complete(Unit)
        withTimeout(3000) { while(p.sources(admissionSerial,1).list.size < 2) delay(20) }
        val fullAvailability = p.availability(admissionSerial).episodes
        val fullLines=p.sources(admissionSerial,1).list.size
        println("lateCatalogue earlyEpisodes=$earlyAvailability earlySources=$earlyLines lateEpisodes=$fullAvailability lateSources=$fullLines")
        assertNull(earlyAvailability)
        assertEquals(5,fullAvailability)
        assertEquals(1,earlyLines)
        assertEquals(2,fullLines)
    }
    @Test fun repeatedLookupsRenewSourceCircuitWithoutARequest() = runBlocking {
        val rules = admissionRules(listOf("only"))
        val calls=AtomicInteger()
        val restored=AtomicBoolean()
        val cat=admissionCatalogue()
        val p=PlaybackService(rules,WarmMediaCache(rules),CatalogueFetcher { url,ms ->
            calls.incrementAndGet()
            if(!restored.get()) error("temporary upstream failure")
            cat.getJson(url,ms)
        },requeryDelayMs=2)
        repeat(2) { runCatching { p.prepareItem(admissionMovie,1) } }
        val before=calls.get()
        restored.set(true)
        delay(16000)
        val first=runCatching { p.prepareItem(admissionMovie,1) }
        delay(15500)
        val second=runCatching { p.prepareItem(admissionMovie,1) }
        println("catalogueCooldown afterRecovery=31.5s probesBeforeRecovery=$before newProbes=" + (calls.get()-before) + " status16s=" + first.exceptionOrNull()?.message + " status31s=" + second.exceptionOrNull()?.message)
        assertTrue(first.isFailure && second.isFailure)
        assertTrue(before>=3)
        assertEquals(before,calls.get())
    }
}
