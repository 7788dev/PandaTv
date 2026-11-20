package app.panda.tv

import app.panda.tv.data.DoubanHttp
import app.panda.tv.data.HttpReply
import app.panda.tv.data.MetadataFetcher
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Test

class MetadataFlightTest {
    @Test
    fun `cancelled suggestion leader cannot cancel a submitted search follower`() = runBlocking {
        var calls = 0
        val started = CompletableDeferred<Unit>()
        val http = DoubanHttp(fetcher = MetadataFetcher { _, _ ->
            if (++calls == 1) {
                started.complete(Unit)
                awaitCancellation()
            }
            HttpReply(200, "[\"verified identity\"]")
        }, intervalMs = 0L)
        val url = "https://movie.douban.com/j/subject_suggest?q=example"
        val leader = launch { http.json(url, 1000L, { it }) }
        started.await()
        val follower = async { http.json(url, 1000L, { it }) }
        yield()
        leader.cancelAndJoin()
        assertEquals(listOf("verified identity"), withTimeout(1000L) { follower.await() })
        assertEquals(2, calls)
    }
}
