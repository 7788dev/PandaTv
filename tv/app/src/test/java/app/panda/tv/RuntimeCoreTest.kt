package app.panda.tv

import app.panda.tv.model.HistoryEntry
import app.panda.tv.model.Json
import app.panda.tv.model.Quality
import app.panda.tv.model.StateAction
import app.panda.tv.net.PublicNetwork
import app.panda.tv.net.TlsCompat
import app.panda.tv.playback.SharedSegmentFlow
import app.panda.tv.playback.SourceRulesLoader
import app.panda.tv.playback.WarmMediaCache
import app.panda.tv.state.UserStore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class RuntimeCoreTest {
    private fun assetFile(name: String): File = listOf(
        File("src/main/assets/$name"),
        File("app/src/main/assets/$name"),
    ).first { it.exists() }

    @Test
    fun `json roundtrip preserves unicode and escapes`() {
        val obj = linkedMapOf<String, Any?>(
            "title" to "三体 \"2023\"\\剧集\n第二行",
            "score" to 8.8,
            "count" to 30,
            "ok" to true,
            "empty" to null,
            "list" to listOf("a", "b", 123),
        )
        val encoded = Json.stringify(obj)
        val parsed = Json.parseObject(encoded)
        assertEquals("三体 \"2023\"\\剧集\n第二行", parsed["title"])
        assertEquals(8.8, (parsed["score"] as Number).toDouble(), 0.0001)
        assertEquals(30L, (parsed["count"] as Number).toLong())
        assertEquals(true, parsed["ok"])
        assertEquals(null, parsed["empty"])
        assertEquals(listOf("a", "b", 123L), parsed["list"])
    }

    @Test
    fun `user store persists favorites history searches and settings`() {
        val tmpDir = Files.createTempDirectory("panda-tv-state-").toFile()
        try {
            val file = File(tmpDir, "user-state.json")
            val store = UserStore(file)
            store.dispatch(StateAction.ToggleFavorite("db-26647087"))
            store.dispatch(StateAction.AddSearch("三体"))
            store.dispatch(StateAction.AddSearch("凡人修仙传"))
            store.dispatch(StateAction.RecordHistory(HistoryEntry("db-26647087", 3, 420.0, 2700.0, System.currentTimeMillis())))
            store.dispatch(StateAction.UpdateSettings(quality = Quality.Q720P, speed = 1.25))

            val restored = UserStore(file).get()
            assertEquals(listOf("db-26647087"), restored.favorites)
            assertEquals(listOf("凡人修仙传", "三体"), restored.searches)
            assertEquals(1, restored.history.size)
            assertEquals(3, restored.history[0].episode)
            assertEquals(Quality.Q720P, restored.settings.quality)
            assertEquals(1.25, restored.settings.speed, 0.0001)
        } finally {
            tmpDir.deleteRecursively()
        }
    }

    @Test
    fun `public network rejects private ips and unsafe ports while allowing fake-ip domain resolution`() {
        assertFalse(PublicNetwork.isPublicAddress("127.0.0.2", allowFakeIp = true))
        assertFalse(PublicNetwork.isPublicAddress("192.168.1.1", allowFakeIp = true))
        assertFalse(PublicNetwork.isPublicAddress("10.0.0.1", allowFakeIp = true))
        assertFalse(PublicNetwork.isPublicAddress("198.18.0.1", allowFakeIp = false))
        assertTrue(PublicNetwork.isPublicAddress("198.18.0.1", allowFakeIp = true))
        assertTrue(PublicNetwork.isPublicAddress("223.5.5.5", allowFakeIp = false))
        assertFalse(PublicNetwork.isPublicAddress("::1", allowFakeIp = true))

        assertTrue(PublicNetwork.allowedPort(65))
        assertTrue(PublicNetwork.allowedPort(18443))
        assertFalse(PublicNetwork.allowedPort(22))
        assertFalse(PublicNetwork.allowedPort(6667))

        assertThrows(Exception::class.java) { PublicNetwork.validatePublicUrl("http://198.18.0.1/a.m3u8") }
        assertThrows(Exception::class.java) { PublicNetwork.validatePublicUrl("http://127.0.0.1/a.m3u8") }
        assertThrows(Exception::class.java) { PublicNetwork.validatePublicUrl("https://user:pass@example.com/a.m3u8") }
    }

    @Test
    fun `bundled mozilla ca store and play sources match desktop`() {
        val pem = assetFile("cacerts.pem")
        val (_, certCount) = pem.inputStream().use { TlsCompat.createSocketFactory(it) }
        assertTrue("Expected >= 140 bundled Mozilla root CAs, got $certCount", certCount >= 140)

        val tvSources = assetFile("play-sources.json")
        val desktopSources = listOf(
            File("../resources/play-sources.json"),
            File("../../resources/play-sources.json"),
        ).first { it.exists() }
        assertEquals(desktopSources.readText(Charsets.UTF_8), tvSources.readText(Charsets.UTF_8))
        val parsed = SourceRulesLoader.validate(tvSources.readText(Charsets.UTF_8))
        assertTrue(parsed.sources.count { it.enabled } >= 8)
    }

    @Test
    fun `shared segment flow streams chunks without full copies and throws on fail`() {
        var finishedBytes: ByteArray? = null
        val flow = SharedSegmentFlow("video/mp2t", 12L) { bytes -> finishedBytes = bytes }
        val reader = flow.openReader()
        assertTrue(flow.write("abcd".toByteArray(), 4))
        assertTrue(flow.write("efgh1234".toByteArray(), 8))
        flow.end()

        val out = ByteArrayOutputStream()
        val buf = ByteArray(5)
        while (true) {
            val n = reader.read(buf, 0, buf.size)
            if (n < 0) break
            out.write(buf, 0, n)
        }
        reader.close()
        assertEquals("abcdefgh1234", out.toString(Charsets.UTF_8.name()))
        assertEquals("abcdefgh1234", finishedBytes?.toString(Charsets.UTF_8))

        val broken = SharedSegmentFlow("video/mp2t", 10L) {}
        val brokenReader = broken.openReader()
        broken.write("part".toByteArray(), 4)
        broken.fail()
        assertThrows(IOException::class.java) {
            brokenReader.read(buf, 0, buf.size)
        }
        brokenReader.close()
    }

    @Test
    fun `warm media cache keeps playlists and keys while evicting one-shot media segments`() {
        val rules = SourceRulesLoader.validate(assetFile("play-sources.json").readText(Charsets.UTF_8))
        val cache = WarmMediaCache(rules)
        val playlistUrl = "https://cdn.example.com/vod/index.m3u8"
        val segmentUrl = "https://cdn.example.com/vod/seg0001.ts"
        cache.warm(playlistUrl, playlistUrl, "#EXTM3U\n#EXT-X-ENDLIST\n".toByteArray(), "application/vnd.apple.mpegurl")
        cache.warm(segmentUrl, segmentUrl, ByteArray(100_000) { 0x47 }, "video/mp2t")

        assertNotNull(cache.getWarmed(playlistUrl, evictIfLargeSegment = true))
        assertNotNull(cache.getWarmed(playlistUrl, evictIfLargeSegment = true))

        assertNotNull(cache.getWarmed(segmentUrl, evictIfLargeSegment = true))
        assertNull(cache.getWarmed(segmentUrl, evictIfLargeSegment = true))
    }

    @Test
    fun `completed warm flow still delivers bytes to a reader attaching after completion`() {
        var cached: ByteArray? = null
        val flow = SharedSegmentFlow("video/mp2t", 12L) { cached = it }
        flow.write("first ".toByteArray())
        flow.write("frame!".toByteArray())
        flow.end()
        val reader = flow.openReader()
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(5)
        try {
            while (true) {
                val count = reader.read(buffer, 0, buffer.size)
                if (count < 0) break
                out.write(buffer, 0, count)
            }
        } finally {
            reader.close()
        }
        assertEquals("first frame!", cached?.toString(Charsets.UTF_8))
        assertEquals("A late player must receive the first segment, not an empty stream", "first frame!", out.toString(Charsets.UTF_8.name()))
    }

    @Test
    fun `oversized unconsumed warm segment cannot leave a later reader waiting forever`() {
        val flow = SharedSegmentFlow("video/mp2t", SharedSegmentFlow.WARM_ITEM_BYTES + 1L) {}
        assertFalse(flow.write(ByteArray(SharedSegmentFlow.WARM_ITEM_BYTES.toInt() + 1)))
        val executor = Executors.newSingleThreadExecutor()
        val future = executor.submit<Int> {
            val reader = flow.openReader()
            try { reader.read(ByteArray(16), 0, 16) } finally { reader.close() }
        }
        try {
            val error = assertThrows(ExecutionException::class.java) { future.get(300L, TimeUnit.MILLISECONDS) }
            assertTrue(error.cause is IOException)
        } finally {
            future.cancel(true)
            executor.shutdownNow()
        }
    }
}
