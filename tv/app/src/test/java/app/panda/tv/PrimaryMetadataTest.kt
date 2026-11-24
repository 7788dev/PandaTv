package app.panda.tv

import app.panda.tv.data.DoubanDataSource
import app.panda.tv.data.HttpReply
import app.panda.tv.data.MetadataFetcher
import app.panda.tv.model.MediaItem
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.atomic.AtomicInteger

// The frozen pre-fix client's playback admission called detail. This test-only compatibility
// extension maps that old entry point; the current subject member takes precedence.
@Suppress("EXTENSION_SHADOWED_BY_MEMBER")
private suspend fun DoubanDataSource.subject(id: String): MediaItem = detail(id)

class PrimaryMetadataTest {
    @Test
    fun `primary admission completes while the full detail still waits for optional responses`() = runBlocking {
        val release = CompletableDeferred<Unit>()
        val optionalStarted = CompletableDeferred<Unit>()
        val optionalRequests = AtomicInteger()
        val source = DoubanDataSource(fetcher = MetadataFetcher { url, _ ->
            when {
                url.contains("/credits") || url.contains("/photos") -> {
                    if (optionalRequests.incrementAndGet() == 2) optionalStarted.complete(Unit)
                    release.await()
                    if (url.contains("/credits")) HttpReply(200, """{"items":[]}""")
                    else HttpReply(200, """{"photos":[]}""")
                }
                else -> HttpReply(200, """{"id":"1","title":"Title 1","type":"movie","genres":["剧情"],"year":"2023"}""")
            }
        })
        val complete = async { source.detail("db-1") }
        var admitted: kotlinx.coroutines.Deferred<MediaItem>? = null
        try {
            withTimeout(2000L) { optionalStarted.await() }
            admitted = async { source.subject("db-1") }
            delay(200L)
            assertTrue("Primary metadata waited for the blocked optional requests", admitted.isCompleted)
            assertEquals("db-1", admitted.await().id)
            assertFalse("The test did not keep full detail blocked", complete.isCompleted)
            assertEquals(2, optionalRequests.get())
        } finally {
            release.complete(Unit)
            admitted?.await()
            complete.await()
        }
    }
}
