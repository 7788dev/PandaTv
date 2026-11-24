package app.panda.tv

import app.panda.tv.model.MediaItem
import app.panda.tv.model.MediaType
import app.panda.tv.model.Json
import app.panda.tv.net.PublicResponse
import app.panda.tv.playback.CatalogueFetcher
import app.panda.tv.playback.MediaFetcher
import app.panda.tv.playback.PlaybackService
import app.panda.tv.playback.SourceRulesLoader
import app.panda.tv.playback.WarmMediaCache
import app.panda.tv.playback.mp4Opening
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.File
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL

class PlaybackPreferencesTest {
    private val item = MediaItem("db-1", "Test work", MediaType.TV, emptyList(), year = 2023)
    private val rules = SourceRulesLoader.validate(listOf(
        File("src/main/assets/play-sources.json"), File("app/src/main/assets/play-sources.json"),
    ).first { it.exists() }.readText()).let { original ->
        original.copy(sources = original.sources.filter { it.enabled }.take(3).mapIndexed { index, source ->
            val name = listOf("one", "two", "three")[index]
            source.copy(key = name, name = name, api = "https://$name.example.com/api", priority = 3 - index)
        })
    }
    private fun service(delays: Map<Pair<String, Int>, Long>, opened: (String, Int) -> Unit = { _, _ -> }): PlaybackService {
        val metadata = CatalogueFetcher { raw, _ ->
            val name = URI(raw).host.substringBefore('.')
            Json.stringify(mapOf("pagecount" to 1, "list" to listOf(mapOf(
                "vod_id" to "1", "vod_name" to item.title, "vod_year" to "2023", "type_name" to "电视剧",
                "vod_play_from" to "mp4", "vod_play_url" to (1..3).joinToString("#") { "第${it}集\$https://$name-media.example.com/$it.mp4" },
            ))))
        }
        val media = object : MediaFetcher {
            override suspend fun text(url: String): Pair<String, String> = error("MP4 admission does not read a manifest")
            override suspend fun open(url: String, headers: Map<String, String>): PublicResponse {
                val uri = URI(url)
                val name = uri.host.substringBefore("-media")
                val episode = uri.path.substringAfterLast('/').substringBefore('.').toInt()
                opened(name, episode)
                delay(delays[name to episode] ?: 0L)
                val connection = object : HttpURLConnection(URL(url)) {
                    override fun connect() {}
                    override fun disconnect() {}
                    override fun usingProxy() = false
                }
                return PublicResponse(206, url, "video/mp4", mp4Opening.size.toLong(), null, "bytes", ByteArrayInputStream(mp4Opening), connection)
            }
        }
        return PlaybackService(rules, WarmMediaCache(rules), metadata, searchGraceMs = 10L,
            requeryDelayMs = 0L, firstSegmentGraceMs = 500L, betterPictureMs = 10L, turnMs = 1000L, mediaFetcher = media)
    }

    @Test
    fun `manual choice replaces a previously completed next episode preload`() = runBlocking {
        val playback = service(mapOf(("two" to 2) to 300L, ("three" to 2) to 400L))
        assertEquals("one", URI(playback.resolve(item, 2).url).host.substringBefore("-media"))
        playback.resolve(item, 1, from = "two")
        assertEquals("two", URI(playback.resolve(item, 2).url).host.substringBefore("-media"))
        assertEquals("two", playback.sources(item, 2).current)
    }

    @Test
    fun `late next episode preload cannot overwrite a committed manual choice`() = runBlocking {
        val started = CompletableDeferred<Unit>()
        val playback = service(mapOf(("one" to 2) to 200L, ("two" to 2) to 600L, ("three" to 2) to 700L)) { name, ep ->
            if (name == "one" && ep == 2) started.complete(Unit)
        }
        val preparing = async { playback.resolve(item, 2) }
        started.await()
        playback.resolve(item, 1, from = "two")
        assertEquals("one", URI(preparing.await().url).host.substringBefore("-media"))
        assertEquals("two", URI(playback.resolve(item, 2).url).host.substringBefore("-media"))
        assertEquals("two", playback.sources(item, 2).current)
    }

    @Test
    fun `a superseded manual result cannot replace a newer successful source`() = runBlocking {
        val started = CompletableDeferred<Unit>()
        val playback = service(mapOf(("two" to 1) to 200L)) { name, ep ->
            if (name == "two" && ep == 1) started.complete(Unit)
        }
        val older = async { playback.resolve(item, 1, from = "two") }
        started.await()
        val latest = playback.resolve(item, 1, from = "three")
        older.await()
        assertEquals("three", playback.sources(item, 1).current)
        assertEquals(latest, playback.resolve(item, 1))
        assertEquals("three", URI(playback.resolve(item, 2).url).host.substringBefore("-media"))
    }
}
