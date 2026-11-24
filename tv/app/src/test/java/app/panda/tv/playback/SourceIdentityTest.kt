package app.panda.tv.playback

import app.panda.tv.model.Json
import app.panda.tv.model.MediaItem
import app.panda.tv.model.MediaType
import app.panda.tv.net.PublicResponse
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.*
import org.junit.Test
import java.util.Collections
import java.util.concurrent.atomic.AtomicInteger

class SourceIdentityTest {
    private val item = MediaItem("db-26647087", "三体", MediaType.TV, emptyList(), year = 2023, region = "中国大陆")
    private fun raw(area: String?) = RawVod("2", "三体第一季", "2023–", "欧美剧", null, null, area)

    @Test fun `production country conflicts exclude another adaptation despite a matching title and misreported year`() {
        assertNull(PlaybackMatchers.matchRecord(item, raw("美国")))
        assertNull(PlaybackMatchers.matchRecord(item, raw("美国").copy(vodYear = "2024")))
        assertNotNull(PlaybackMatchers.matchRecord(item, raw("内地").copy(typeName = "国产剧")))
        assertNotNull(PlaybackMatchers.matchRecord(item.copy(region = "中国大陆 / 中国香港"), raw("香港")))
        assertNotNull(PlaybackMatchers.matchRecord(item, raw("中国台湾 / 中国大陆")))
        for (area in listOf(null, "", "未知", "欧美")) assertNotNull(PlaybackMatchers.matchRecord(item, raw(area)))
        assertNotNull(PlaybackMatchers.matchRecord(item.copy(region = null), raw("美国")))
    }

    @Test fun `numbered mirrors preserve every distinct media address without counting bonuses or duplicates as episodes`() {
        val entries = listOf("彩蛋1" to "bonus", "幕后" to "behind", "第01集" to "a-1", "第01集" to "a-1",
            "第01集" to "b-1", "第02集" to "a-2", "第02集" to "b-2", "第03集" to "a-3")
        val lines = PlaybackMatchers.parseLines("mp4", entries.joinToString("#") { "${it.first}${'$'}https://media.example.org/${it.second}.mp4" })
        assertEquals(listOf(true, true), lines.map { PlaybackMatchers.numbering(it).numeric })
        val primary = requireNotNull(PlaybackMatchers.referenceLine(lines))
        assertEquals(3, PlaybackMatchers.numbering(primary).count)
        assertEquals("https://media.example.org/a-1.mp4", PlaybackMatchers.numbering(primary).byNumber[1]?.url)
        assertEquals(listOf("a-1", "a-2", "a-3", "b-1", "b-2").map { "https://media.example.org/$it.mp4" }, lines.flatMap { it.episodes }.map { it.url })
    }

    @Test fun `variety dates and mixed special episodes retain their positional order`() {
        for (titles in listOf(listOf("先导片上", "20241118", "20241125"), listOf("第01集", "特别篇01", "第02集"))) {
            val lines = PlaybackMatchers.parseLines("hls", titles.mapIndexed { i, title -> "$title${'$'}https://media.example.org/$i.m3u8" }.joinToString("#"))
            assertEquals(1, lines.size)
            assertEquals(titles, lines.single().episodes.map { it.title })
            assertFalse(PlaybackMatchers.numbering(lines.single()).numeric)
        }
    }

    private fun catalogue(): String = Json.stringify(mapOf("pagecount" to 1, "list" to listOf(
        mapOf("vod_id" to 2, "vod_name" to "三体第一季", "vod_year" to "2023–", "vod_area" to "美国", "type_name" to "欧美剧", "vod_play_from" to "mp4",
            "vod_play_url" to (1..8).joinToString("#") { "第${it}集${'$'}https://a.media.example.org/remake-$it.mp4" }),
        mapOf("vod_id" to 1, "vod_name" to "三体", "vod_year" to "2023", "vod_area" to "中国大陆", "type_name" to "国产剧", "vod_play_from" to "mp4",
            "vod_play_url" to (listOf("彩蛋${'$'}https://a.media.example.org/bonus.mp4", "第1集${'$'}https://a.media.example.org/primary-1.mp4",
                "第1集${'$'}https://a.media.example.org/mirror-1.mp4") + (2..30).map { "第${it}集${'$'}https://a.media.example.org/primary-$it.mp4" }).joinToString("#")),
    )))

    @Test fun `the real selection service admits the requested adaptation and falls back within the same numbered episode`() = runBlocking {
        val rules = admissionRules(listOf("a"))
        val requests = Collections.synchronizedList(ArrayList<String>())
        val media = object : MediaFetcher {
            override suspend fun text(url: String): Pair<String, String> = error("Unexpected manifest")
            override suspend fun open(url: String, headers: Map<String, String>): PublicResponse {
                requests.add(url)
                return admissionResponse(url, if (url.contains("primary-1.")) "{\"error\":\"offline\"}".toByteArray() else mp4Opening).first
            }
        }
        val service = PlaybackService(rules, WarmMediaCache(rules), CatalogueFetcher { _, _ -> catalogue() }, searchGraceMs = 10, betterPictureMs = 20, mediaFetcher = media)
        assertEquals(30, service.availability(item).episodes)
        withTimeout(3000) { service.resolve(item, 1) }
        assertEquals(listOf("https://a.media.example.org/mirror-1.mp4", "https://a.media.example.org/primary-1.mp4"), requests.sorted())
        assertEquals("a", service.sources(item, 1).current)
    }

    @Test fun `candidate caches include the requested production region`() = runBlocking {
        val rules = admissionRules(listOf("a"))
        val calls = AtomicInteger()
        val requests = Collections.synchronizedList(ArrayList<String>())
        val media = object : MediaFetcher {
            override suspend fun text(url: String): Pair<String, String> = error("Unexpected manifest")
            override suspend fun open(url: String, headers: Map<String, String>): PublicResponse {
                requests.add(url); return admissionResponse(url).first
            }
        }
        val service = PlaybackService(rules, WarmMediaCache(rules), CatalogueFetcher { _, _ -> calls.incrementAndGet(); catalogue() }, searchGraceMs = 10, betterPictureMs = 20, mediaFetcher = media)
        assertEquals(30, service.availability(item).episodes)
        val chinese = withTimeout(3000) { service.resolve(item, 1) }
        assertEquals(8, service.availability(item.copy(region = "美国")).episodes)
        val american = withTimeout(3000) { service.resolve(item.copy(region = "美国"), 1) }
        assertNotEquals(chinese.url, american.url)
        assertTrue(requests.last().contains("remake-1"))
        assertEquals(2, calls.get())
    }
}
