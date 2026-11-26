package app.panda.tv

import app.panda.tv.data.DoubanDataSource
import app.panda.tv.data.HttpReply
import app.panda.tv.data.MetadataFetcher
import app.panda.tv.data.MetadataStore
import app.panda.tv.data.Normalize
import app.panda.tv.model.Json
import app.panda.tv.model.MediaType
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File
import java.nio.file.Files

class MetadataStoreTest {
    @Test
    fun oversizedNewestRecordKeepsRecentWholeUtf8Records() = runBlocking {
        val directory = Files.createTempDirectory("panda-tv-metadata-").toFile()
        try {
            val synopsis = "影".repeat(400_000)
            val store = MetadataStore(directory)
            store.set((1..5).map { id -> Normalize.normalize(mapOf(
                "id" to id.toString(), "title" to "影片$id", "intro" to if (id == 5) synopsis.repeat(4) else synopsis,
            ))!! })
            store.flush()
            val restored = MetadataStore(directory)
            assertEquals(listOf("db-2", "db-3", "db-4"), restored.values().map { it.item.id })
            assertEquals(synopsis.length, restored.get("db-4")!!.item.synopsis!!.length)
            org.junit.Assert.assertTrue(File(directory, "metadata-v1.json").length() <= 4 * 1024 * 1024)
        } finally { directory.deleteRecursively() }
    }

    @Test
    fun `compact cards cannot erase a verified thematic type across a restart`() = runBlocking {
        for ((type, evidence) in listOf(
            MediaType.ANIME to mapOf("genres" to listOf("动画", "奇幻")),
            MediaType.DOC to mapOf("genres" to listOf("纪录片")),
            MediaType.VARIETY to mapOf("genres" to listOf("音乐"), "is_show" to true),
        )) {
            val directory = Files.createTempDirectory("panda-tv-metadata-").toFile()
            try {
                val store = MetadataStore(directory)
                val full = Normalize.normalize(mapOf("id" to "1", "type" to "tv", "title" to "真实条目", "intro" to "原始简介", "episodes_count" to 12, "aka" to listOf("真实别名")) + evidence)!!
                assertEquals(type, full.item.type)
                store.set(listOf(full))
                store.set(listOf(Normalize.normalize(mapOf("id" to "1", "type" to "tv", "title" to "真实条目", "genres" to listOf("剧情")))!!))
                assertEquals(type, store.get("db-1")!!.item.type)
                assertEquals("原始简介", store.get("db-1")!!.item.synopsis)
                assertEquals(listOf("真实别名"), store.get("db-1")!!.aliases)
                store.flush()
                assertEquals(type, MetadataStore(directory).get("db-1")!!.item.type)
            } finally {
                directory.deleteRecursively()
            }
        }
    }

    @Test
    fun `new positive genre evidence can upgrade a plain format`() {
        val store = MetadataStore()
        store.set(listOf(Normalize.normalize(mapOf("id" to "2", "type" to "tv", "title" to "真实条目", "genres" to listOf("剧情")))!!))
        store.set(listOf(Normalize.normalize(mapOf("id" to "2", "type" to "tv", "title" to "真实条目", "genres" to listOf("动画")))!!))
        assertEquals(MediaType.ANIME, store.get("db-2")!!.item.type)
    }

    @Test
    fun `a supported 2501 title library is read in order`() = runBlocking {
        val directory = Files.createTempDirectory("panda-tv-library-").toFile()
        try {
            // Read the 2500 cached rows first and the one uncached row last, so
            // this checks the collection limit without thousands of network calls.
            val now = System.currentTimeMillis()
            val cached = (2..2501).map { index -> mapOf(
                "kind" to "movie", "updatedAt" to now,
                "item" to mapOf("id" to "db-$index", "title" to "db-$index", "type" to "movie", "genres" to emptyList<String>()),
            ) }
            File(directory, "metadata-v1.json").writeText(Json.stringify(mapOf("version" to 1, "records" to cached)), Charsets.UTF_8)
            val source = DoubanDataSource(cacheDir = directory, fetcher = MetadataFetcher { url, _ ->
                val body = when {
                    url.endsWith("/credits") -> mapOf("items" to emptyList<Any?>())
                    url.contains("/photos?") -> mapOf("photos" to emptyList<Any?>())
                    else -> mapOf("id" to "1", "type" to "movie", "title" to "db-1", "genres" to emptyList<String>())
                }
                HttpReply(200, Json.stringify(body))
            })
            val ids = (2..2501).map { "db-$it" } + "db-1"
            assertEquals(ids, source.byIds(ids).map { it.id })
        } finally {
            directory.deleteRecursively()
        }
    }
}
