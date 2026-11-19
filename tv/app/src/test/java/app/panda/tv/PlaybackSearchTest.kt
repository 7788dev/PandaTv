package app.panda.tv

import app.panda.tv.model.Copy
import app.panda.tv.model.Json
import app.panda.tv.model.MediaItem
import app.panda.tv.model.MediaType
import app.panda.tv.playback.CatalogueFetcher
import app.panda.tv.playback.PlaybackService
import app.panda.tv.playback.SourceRulesLoader
import app.panda.tv.playback.WarmMediaCache
import kotlinx.coroutines.delay
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.net.URI
import java.util.concurrent.atomic.AtomicInteger

class PlaybackSearchTest {
    private val item = MediaItem("test-missing", "Test work", MediaType.TV, emptyList(), year = 2023)
    private val rules = SourceRulesLoader.validate(listOf(
        File("src/main/assets/play-sources.json"), File("app/src/main/assets/play-sources.json"),
    ).first { it.exists() }.readText()).let { it.copy(sources = it.sources.filter { s -> s.enabled }.take(2)) }

    private fun found(id: String, episodes: String = "第1集\$https://cdn.example.com/1.m3u8") = Json.stringify(mapOf(
        "list" to listOf(mapOf(
            "vod_id" to id, "vod_name" to item.title, "vod_year" to "2023", "type_name" to "电视剧",
            "vod_play_from" to "hls", "vod_play_url" to episodes,
        )), "pagecount" to 1,
    ))

    private fun service(fetch: CatalogueFetcher) = PlaybackService(
        rules, WarmMediaCache(rules), fetch, searchGraceMs = 40L, requeryDelayMs = 10L,
    )

    private suspend fun errorOf(block: suspend () -> Unit): Throwable = try {
        block()
        throw AssertionError("Expected a source verdict")
    } catch (error: IllegalStateException) {
        error
    }

    @Test
    fun `confirmed empty catalogues reject admission without fabricating episodes`() = runBlocking {
        val playback = service { _, _ -> "{\"list\":[],\"pagecount\":1}" }
        assertEquals(Copy.Extra.SOURCE_UNAVAILABLE, errorOf { playback.prepareItem(item, 1) }.message)
        assertEquals(null, playback.knownEpisodes(item.id))
    }

    @Test
    fun `a catalogue with only episode one rejects episode two before player entry`() = runBlocking {
        val playback = service { _, _ -> found("1") }
        assertEquals(item.id, playback.prepareItem(item, 1).id)
        assertEquals(Copy.Extra.NO_EPISODE, errorOf { playback.prepareItem(item, 2) }.message)
    }

    @Test
    fun `recent failed catalogue is retryable and never cached as absence`() = runBlocking {
        val failingHost = URI(rules.sources.last().api).host
        val calls = AtomicInteger()
        val playback = service { url, _ ->
            calls.incrementAndGet()
            if (URI(url).host == failingHost) throw IllegalStateException("connection timed out")
            "{\"list\":[],\"pagecount\":1}"
        }
        assertEquals(Copy.Extra.UNAVAILABLE, errorOf { playback.prepareItem(item, 1) }.message)
        val firstCalls = calls.get()
        assertEquals(Copy.Extra.UNAVAILABLE, errorOf { playback.prepareItem(item, 1) }.message)
        assertTrue("Failure must cause another lookup", calls.get() > firstCalls)
    }

    @Test
    fun `first playable answer returns without waiting for slow catalogue`() = runBlocking {
        val slowHost = URI(rules.sources.last().api).host
        val playback = service { url, _ ->
            if (URI(url).host == slowHost) {
                delay(650L)
                found("slow")
            } else {
                delay(15L)
                found("fast")
            }
        }
        val started = System.nanoTime()
        playback.prepareItem(item, 1)
        val elapsedMs = (System.nanoTime() - started) / 1_000_000L
        assertTrue("Playable answer waited ${elapsedMs}ms for a slow catalogue", elapsedMs < 400L)
    }

    @Test
    fun `late catalogue source is kept after the early answer is cached`() = runBlocking {
        val slowHost = URI(rules.sources.last().api).host
        val playback = service { url, _ ->
            if (URI(url).host == slowHost) delay(650L) else delay(15L)
            found(if (URI(url).host == slowHost) "slow" else "fast")
        }
        playback.prepareItem(item, 1)
        delay(750L)
        assertEquals("Late source must be present in the cache", 2, playback.sources(item, 1).list.size)
    }

    @Test
    fun `cancelling one screen does not cancel a shared playback admission`() = runBlocking {
        val asked = CompletableDeferred<Unit>()
        val answer = CompletableDeferred<Unit>()
        val calls = AtomicInteger()
        val playback = service { _, _ ->
            calls.incrementAndGet()
            asked.complete(Unit)
            answer.await()
            found("1")
        }
        val first = async { playback.prepareItem(item, 1) }
        asked.await()
        val second = async { playback.prepareItem(item, 1) }
        delay(15L)
        first.cancelAndJoin()
        answer.complete(Unit)
        assertEquals(item.id, withTimeout(800L) { second.await() }.id)
        assertEquals("Screens share one request per enabled source", 2, calls.get())
    }

    @Test
    fun `cancelling a preload does not cancel an active resolver awaiting it`() = runBlocking {
        val asked = CompletableDeferred<Unit>()
        val answer = CompletableDeferred<Unit>()
        val playback = service { _, _ ->
            asked.complete(Unit)
            answer.await()
            "{\"list\":[],\"pagecount\":1}"
        }
        val preload = async { playback.resolve(item, 1) }
        asked.await()
        val active = async { runCatching { playback.resolve(item, 1) }.exceptionOrNull() }
        delay(20L)
        preload.cancelAndJoin()
        answer.complete(Unit)
        val result = withTimeout(1_000L) { active.await() }
        assertEquals("An active request must recover the cancelled shared resolution", Copy.Extra.NO_EPISODE, result?.message)
    }
}
