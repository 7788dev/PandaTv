package app.panda.tv.playback

import app.panda.tv.model.Quality
import app.panda.tv.net.PublicResponse
import app.panda.tv.state.SourceHealthStore
import app.panda.tv.ui.playbackFailureKind
import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Test
import java.net.URL
import java.util.Collections
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.CountDownLatch
import java.nio.file.Files

class MediaAdmissionTest {
    private fun client(
        keys: List<String>,
        fetcher: MediaFetcher,
        serial: Boolean = false,
        hlsSource: String? = null,
        betterPictureMs: Long = 1000,
        turnMs: Long = 2_500,
        health: SourceHealthStore? = null,
        alignment: AlignmentConfig? = null,
    ): PlaybackService {
        val rules = admissionRules(keys)
        return PlaybackService(rules, WarmMediaCache(rules), admissionCatalogue(if (serial) admissionSerial else admissionMovie, hlsSource),
            searchGraceMs = 100, betterPictureMs = betterPictureMs, firstSegmentGraceMs = 3000, turnMs = turnMs,
            mediaFetcher = fetcher, health = health, alignment = alignment)
    }

    private fun health(file: java.io.File) = SourceHealthStore(
        file,
        HealthConfig(
            basisVersion = "test",
            decayVersion = "1",
            halfLifeDays = 30.0,
            baseline = 0.5,
            slowStartupSec = 8.0,
            playFloorSec = 60.0,
            workDeltaMax = 0.2,
            weights = HealthWeights(0.4, 0.3, 0.2, 0.1),
        ),
        BudgetConfig(3, 30.0, 300.0),
    )
    private fun media(respond: suspend (String) -> PublicResponse) = object : MediaFetcher {
        override suspend fun text(url: String): Pair<String, String> = error("Unexpected manifest")
        override suspend fun open(url: String, headers: Map<String, String>) = respond(url)
    }

    @Test fun `a different cut cannot replace the active media or manual preference`() = runBlocking {
        val dir = Files.createTempDirectory("panda-tv-duration").toFile()
        try {
            val archive = java.io.File(dir, "health.json")
            val store = health(archive)
            val config = AlignmentConfig("test", .01, 5.0, .05, 4.0, 3.0, 5, 1200L, .9, 7.0, 1.5)
            val fetch = media { url ->
                val seconds = if (url.contains("a.media")) 90 else 30
                val mvhd = java.nio.ByteBuffer.allocate(32).apply {
                    position(4); put("mvhd".toByteArray()); putInt(20, 1000); putInt(24, seconds * 1000)
                }.array()
                admissionResponse(url, mp4Opening + mvhd).first
            }
            val service = client(listOf("a", "b"), fetch, serial = true, health = store, alignment = config)
            val original = service.resolve(admissionSerial, 1, from = "a")
            assertEquals(90.0, original.duration!!, 0.01)
            assertTrue(runCatching { service.resolve(admissionSerial, 1, from = "b", switchingFrom = original) }.isFailure)
            assertEquals("a", service.sources(admissionSerial, 1).current)
            assertEquals("a", service.resolve(admissionSerial, 2).sourceKey)
            store.flush()
            val restored = health(archive)
            assertEquals(listOf(30.0), restored.durationHistory(admissionSerial.id, 1, "a", "b").sourceSamples)
            assertEquals(1, restored.snapshot().globals.first { it.sourceKey == "b" }.failure.alignment)
        } finally { dir.deleteRecursively() }
    }

    @Test fun `startup failure and stall cool their own sources and an explicit pick can recover`() = runBlocking {
        val dir = Files.createTempDirectory("panda-tv-cooled").toFile()
        try {
            val store = health(java.io.File(dir, "health.json"))
            val opens = AtomicInteger()
            val service = client(listOf("a", "b"), media { url -> opens.incrementAndGet(); admissionResponse(url).first }, health = store)
            service.resolve(admissionMovie, 1, from = "a")
            assertEquals("b", service.resolve(admissionMovie, 1, retry = true, retryFailureKind = playbackFailureKind(false)).sourceKey)
            opens.set(0)
            assertTrue(runCatching { service.resolve(admissionMovie, 1, retry = true, retryFailureKind = playbackFailureKind(true)) }.isFailure)
            assertEquals(0, opens.get())
            val entries = store.snapshot().globals.associateBy { it.sourceKey }
            assertEquals(FailureCounts(probe = 1), entries.getValue("a").failure)
            assertEquals(FailureCounts(stall = 1), entries.getValue("b").failure)
            assertTrue(entries.values.all { it.cooled })
            assertEquals("a", service.resolve(admissionMovie, 1, from = "a").sourceKey)
        } finally { dir.deleteRecursively() }
    }

    @Test fun `fast winner does not await a canceled blocking probe`() = runBlocking {
        val blocked = CountDownLatch(1)
        val started = CompletableDeferred<Unit>()
        val released = CompletableDeferred<Unit>()
        val fetch = media { url ->
            if (url.contains("a.media")) withContext(Dispatchers.IO) {
                started.complete(Unit)
                try { blocked.await() } finally { released.complete(Unit) }
            } else started.await()
            admissionResponse(url).first
        }
        val service = client(listOf("a", "b"), fetch, betterPictureMs = 20)
        val pending = async { service.resolve(admissionMovie, 1) }
        try {
            withTimeout(2000) { started.await() }
            withTimeout(1000) { pending.await() }
            assertEquals("b", service.sources(admissionMovie, 1).current)
            assertFalse("The test must still hold the unused header request", released.isCompleted)
        } finally { blocked.countDown(); pending.cancelAndJoin(); withTimeout(2000) { released.await() } }
    }

    @Test fun `empty and JSON responses lose to the working MP4 and every response closes`() = runBlocking {
        val streams = Collections.synchronizedList(ArrayList<ObservedStream>())
        val fetch = media { url ->
            val (answer, stream) = when {
                url.contains("a.media") -> admissionResponse(url, ByteArray(0))
                url.contains("b.media") -> admissionResponse(url, "{\"error\":\"offline\"}".toByteArray(), "application/json")
                else -> admissionResponse(url)
            }
            streams.add(stream); answer
        }
        val service = client(listOf("a", "b", "c"), fetch)
        withTimeout(5000) { service.resolve(admissionMovie, 1) }
        assertEquals("c", service.sources(admissionMovie, 1).current)
        assertEquals(3, streams.size)
        assertTrue(streams.all { it.closed })
        assertTrue(streams.any { it.received >= 16 })
    }

    @Test fun `video content type does not make a JSON error into media`() = runBlocking {
        val service = client(listOf("a"), media { admissionResponse(it, "{\"error\":\"bad\"}".toByteArray()).first })
        val result = runCatching { withTimeout(5000) { service.resolve(admissionMovie, 1) } }
        assertTrue(result.isFailure)
        assertNull(service.sources(admissionMovie, 1).current)
    }

    @Test fun `failed MP4 probe cools only its source and persists the failure`() = runBlocking {
        val dir = Files.createTempDirectory("panda-tv-probe-health").toFile()
        try {
            val path = java.io.File(dir, "health.json")
            val store = health(path)
            val service = client(
                listOf("a"), media { admissionResponse(it, "{}".toByteArray()).first }, health = store,
            )
            val result = runCatching { withTimeout(5000) { service.resolve(admissionMovie, 1) } }
            assertTrue(result.isFailure)
            val entry = store.snapshot().globals.single()
            assertTrue(entry.cooled)
            assertEquals(1, entry.failure.probe)
            assertEquals(0, entry.failure.firstSegment)
            assertEquals(FailureKind.PROBE, entry.lastFailureKind)
            store.flush()
            val restored = health(path).snapshot().globals.single()
            assertTrue(restored.cooled)
            assertEquals(1, restored.failure.probe)
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test fun `a slow but complete HLS winner is not recorded as a first segment failure`() = runBlocking {
        val dir = Files.createTempDirectory("panda-tv-slow-health").toFile()
        try {
            val store = health(java.io.File(dir, "health.json"))
            val media = object : MediaFetcher {
                override suspend fun text(url: String) =
                    "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nfirst.ts\n#EXT-X-ENDLIST\n" to url

                override suspend fun open(url: String, headers: Map<String, String>): PublicResponse {
                    delay(30)
                    return admissionResponse(url, codecHead("1080"), "video/mp2t").first
                }
            }
            val service = client(
                listOf("a"), media, hlsSource = "a", betterPictureMs = 20, turnMs = 5, health = store,
            )
            withTimeout(5000) { service.resolve(admissionMovie, 1, Quality.Q1080P) }
            val entry = store.snapshot().globals.single()
            assertEquals(1, entry.success)
            assertEquals(FailureCounts(), entry.failure)
            assertEquals(Quality.Q1080P, entry.shownQuality)
            assertTrue((entry.startupMedian ?: 0.0) > 0.0)
            assertNull(entry.lastFailureKind)
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test fun `an unclassified retry does not record a stall against the previous source`() = runBlocking {
        val dir = Files.createTempDirectory("panda-tv-retry-health").toFile()
        try {
            val store = health(java.io.File(dir, "health.json"))
            val service = client(listOf("a"), media { admissionResponse(it).first }, health = store)
            withTimeout(5000) { service.resolve(admissionMovie, 1) }
            withTimeout(5000) { service.resolve(admissionMovie, 1, retry = true) }
            val entry = store.snapshot().globals.single()
            assertEquals(2, entry.success)
            assertEquals(0, entry.failure.stall)
            assertNull(entry.lastFailureKind)
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test fun `a newer automatic request owns its winner after an older request completes`() = runBlocking {
        val release = CompletableDeferred<Unit>()
        val started = AtomicInteger()
        val calls = ConcurrentHashMap<String, AtomicInteger>()
        val fetch = media { url ->
            val key = URL(url).host.substringBefore('.')
            val call = calls.computeIfAbsent(key) { AtomicInteger() }.incrementAndGet()
            started.incrementAndGet()
            if (key == "a" && call == 1) release.await()
            else if ((key == "a" && call == 2) || (key == "b" && call == 1)) error("媒体不可用")
            admissionResponse(url).first
        }
        val service = client(listOf("a", "b"), fetch)
        val old = async { service.resolve(admissionMovie, 1) }
        try {
            withTimeout(3000) { while (started.get() < 2) delay(2) }
            val newer = withTimeout(3000) { service.resolve(admissionMovie, 1, retry = true) }
            assertEquals("b", service.sources(admissionMovie, 1).current)
            release.complete(Unit)
            assertNotEquals(newer.url, withTimeout(3000) { old.await() }.url)
            assertEquals("b", service.sources(admissionMovie, 1).current)
            assertEquals(newer.url, service.resolve(admissionMovie, 1).url)
        } finally { release.complete(Unit); old.cancelAndJoin() }
    }

    @Test fun `a late manual result cannot change the newer fallback or next episode preference`() = runBlocking {
        val release = CompletableDeferred<Unit>()
        val firstStarted = CompletableDeferred<Unit>()
        val aCalls = AtomicInteger()
        val fetch = media { url ->
            if (url.contains("a.media")) {
                if (aCalls.incrementAndGet() == 1) { firstStarted.complete(Unit); release.await() }
                else error("媒体不可用")
            }
            admissionResponse(url).first
        }
        val service = client(listOf("a", "b"), fetch, serial = true)
        val old = async { service.resolve(admissionSerial, 1, from = "a") }
        try {
            withTimeout(3000) { firstStarted.await() }
            withTimeout(3000) { service.resolve(admissionSerial, 1, retry = true) }
            release.complete(Unit); withTimeout(3000) { old.await() }
            assertEquals("b", service.sources(admissionSerial, 1).current)
            withTimeout(3000) { service.resolve(admissionSerial, 2) }
            assertEquals("b", service.sources(admissionSerial, 2).current)
        } finally { release.complete(Unit); old.cancelAndJoin() }
    }

    @Test fun `a successful manual choice invalidates a previously prepared episode`() = runBlocking {
        var preparing = true
        val requests = Collections.synchronizedList(ArrayList<String>())
        val fetch = media { url ->
            requests.add(url)
            if (preparing && url.contains("a.media")) error("媒体不可用")
            admissionResponse(url).first
        }
        val service = client(listOf("a", "b"), fetch, serial = true)
        withTimeout(3000) { service.resolve(admissionSerial, 2) }
        assertEquals("b", service.sources(admissionSerial, 2).current)
        preparing = false
        withTimeout(3000) { service.resolve(admissionSerial, 1, from = "a") }
        val before = requests.size
        withTimeout(3000) { service.resolve(admissionSerial, 2) }
        assertEquals("a", service.sources(admissionSerial, 2).current)
        assertTrue(requests.drop(before).all { it.contains("a.media") })
    }

    @Test fun `queued better picture gets a turn while the first batch completes concurrently`() = runBlocking {
        val goodHead = codecHead("1080")
        repeat(20) {
            val firstBatch = CompletableDeferred<Unit>()
            val starts = AtomicInteger()
            val fetch = object : MediaFetcher {
                override suspend fun text(url: String) = (if (url.endsWith(".m3u8") && url.contains("episode-"))
                    "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1920x1080\nmain.m3u8\n"
                    else "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nfirst.ts\n#EXT-X-ENDLIST\n") to url
                override suspend fun open(url: String, headers: Map<String, String>): PublicResponse {
                    if (url.contains("d.media")) { delay(30); return admissionResponse(url, goodHead, "video/mp2t").first }
                    if (starts.incrementAndGet() == 3) firstBatch.complete(Unit)
                    firstBatch.await()
                    return admissionResponse(url).first
                }
            }
            val service = client(listOf("a", "b", "c", "d"), fetch, hlsSource = "d")
            assertEquals(4, service.sources(admissionMovie, 1).list.size)
            val selected = withTimeout(4000) { service.resolve(admissionMovie, 1, Quality.Q1080P) }
            assertEquals("d", service.sources(admissionMovie, 1).current)
            assertEquals(Quality.Q1080P, selected.quality)
        }
    }

    @Test fun `cached quality playback still agrees with the current selected source`() = runBlocking {
        val rules = admissionRules(listOf("a", "b"))
        val requests = Collections.synchronizedList(ArrayList<String>())
        val catalogue = CatalogueFetcher { url, _ ->
            val key = URL(url).host.substringBefore('.')
            app.panda.tv.model.Json.stringify(mapOf("pagecount" to 1, "list" to listOf(mapOf("vod_id" to 1,
                "vod_name" to admissionMovie.title, "vod_year" to "2023", "type_name" to "电影", "vod_play_from" to "hls",
                "vod_play_url" to "正片${'$'}https://$key.media.example.org/episode-1.m3u8"))))
        }
        val media = object : MediaFetcher {
            override suspend fun text(url: String): Pair<String, String> = "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nfirst.ts\n#EXT-X-ENDLIST\n" to url
            override suspend fun open(url: String, headers: Map<String, String>): PublicResponse {
                val high = url.contains("b.media")
                requests.add(if (high) "b" else "a")
                if (high) delay(15)
                return admissionResponse(url, codecHead(if (high) "720" else "480"), "video/mp2t").first
            }
        }
        val service = PlaybackService(rules, WarmMediaCache(rules), catalogue, searchGraceMs = 10, betterPictureMs = 100, mediaFetcher = media)
        withTimeout(3000) { service.resolve(admissionMovie, 1, Quality.Q480P) }
        assertEquals("a", service.sources(admissionMovie, 1).current)
        withTimeout(3000) { service.resolve(admissionMovie, 1, Quality.Q720P) }
        assertEquals("b", service.sources(admissionMovie, 1).current)
        val before = requests.size
        withTimeout(3000) { service.resolve(admissionMovie, 1, Quality.Q480P) }
        assertEquals("a", service.sources(admissionMovie, 1).current)
        assertTrue(requests.size > before)
        val cached = requests.size
        withTimeout(3000) { service.resolve(admissionMovie, 1, Quality.Q480P) }
        assertEquals(cached, requests.size)
    }
}
