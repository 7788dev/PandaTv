package app.panda.tv

import app.panda.tv.data.*
import app.panda.tv.model.Json
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.*
import org.junit.Test
import java.net.URLDecoder

class HomeAndUpdatesTest {
    private fun homeSource(gate: CompletableDeferred<Unit>, missingMovies: Boolean = false) = DoubanDataSource(
        fetcher = MetadataFetcher { raw, _ ->
            val url = URLDecoder.decode(raw, "UTF-8")
            if (url.contains("subject_collection/tv_hot/")) gate.await()
            if (url.contains("movie_latest") && missingMovies) return@MetadataFetcher HttpReply(404, "{}")
            val chart = url.contains("subject_collection/")
            val type = if (url.contains("movie")) "movie" else "tv"
            val genre = when {
                "综艺" in url -> "真人秀"
                "动画" in url -> "动画"
                "纪录片" in url -> "纪录片"
                else -> "剧情"
            }
            val id = (url.hashCode().toLong() + 2147483648).toString()
            val row = mapOf("id" to id, "title" to "片名$id", "type" to type, "genres" to listOf(genre),
                "cover_url" to "https://img1.doubanio.com/view/poster.jpg")
            HttpReply(200, Json.stringify(mapOf((if (chart) "subject_collection_items" else "items") to listOf(row), "total" to 1, "count" to 1)))
        }, homeRetryMs = emptyList())

    @Test fun coldHomeKeepsEveryPublishedShelf() = runBlocking {
        val gate = CompletableDeferred<Unit>()
        val snapshots = mutableListOf<List<String>>()
        val feed = withTimeout(5000) {
            homeSource(gate).home { update -> snapshots.add(update.shelves.map { it.id }); gate.complete(Unit) }
        }
        val finalIds = feed.shelves.map { it.id }
        assertEquals(setOf("continue","hot-tv","new-movie","rank","variety","anime","doc"), finalIds.toSet())
        assertTrue(snapshots.first().size < finalIds.size)
        assertTrue(snapshots.zipWithNext().all { (a,b) -> b.containsAll(a) })
        assertEquals(finalIds, snapshots.last())
    }

    @Test fun coldHomeKeepsUsableSectionsWhenOnePrimaryFeedFails() = runBlocking {
        val feed = homeSource(CompletableDeferred(Unit), missingMovies = true).home()
        assertTrue(feed.shelves.any { it.id == "hot-tv" })
        assertFalse(feed.shelves.any { it.id == "new-movie" })
    }

    @Test fun updateUsesTheSignedTvAssetFromPublishedStableReleases() {
        fun release(name: String, draft: Boolean = false, pre: Boolean = false) = mapOf("draft" to draft,
            "prerelease" to pre, "html_url" to "https://github.com/7788dev/PandaTv/releases/tag/v3.0.1",
            "assets" to listOf(mapOf("state" to "uploaded", "name" to name, "size" to 5000)))
        val rows = listOf(release("Panda-3.0.1-Setup.exe"), release("Panda-TV-5.0.0.apk", draft = true),
            release("Panda-TV-3.0.0.apk", pre = true), release("Panda-TV-2.0.0-unsigned.apk"),
            release("Panda-TV-1.0.9.apk"), release("Panda-TV-1.0.15.apk"))
        val version = TvUpdates.latest { Json.stringify(rows) }?.version
        assertEquals("1.0.15", version)
        assertTrue(TvUpdates.compareVersions(version!!, "1.0.9") > 0)
        assertNull(TvUpdates.latest { "[]" })
        assertTrue(runCatching { TvUpdates.latest { "{}" } }.isFailure)
    }
}
