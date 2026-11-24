package app.panda.tv.ui

import app.panda.tv.data.DoubanDataSource
import app.panda.tv.data.HttpReply
import app.panda.tv.data.MetadataFetcher
import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Test

class PersonPageLoadTest {
    private val works = """{"total":1,"count":30,"works":[{"work":{"id":"41","title":"回归影片","type":"movie","genres":["剧情"],"year":"2023"}}]}"""
    @Test fun `available works render while optional person information is still pending`() = runBlocking {
        val infoGate = CompletableDeferred<Unit>()
        val rendered = CompletableDeferred<Unit>()
        var infoShown = false
        val data = DoubanDataSource(fetcher = MetadataFetcher { url, _ ->
            if (url.contains("/works")) HttpReply(200, works)
            else { infoGate.await(); HttpReply(200, """{"title":"回归影人"}""") }
        })
        val loading = async { loadPersonPage(data, "1001", { infoShown = true }, { page ->
            assertEquals("db-41", page.items.single().id); rendered.complete(Unit)
        }, { error -> throw AssertionError(error) }) }
        try {
            withTimeout(2500) { rendered.await() }
            assertFalse(infoShown)
            assertFalse(loading.isCompleted)
            infoGate.complete(Unit); withTimeout(2500) { loading.await() }
            assertTrue(infoShown)
        } finally { infoGate.complete(Unit); loading.cancelAndJoin() }
    }
    @Test fun `leaving the page cancels optional information without a late UI update`() = runBlocking {
        val infoGate = CompletableDeferred<Unit>()
        val rendered = CompletableDeferred<Unit>()
        var infoShown = false
        val data = DoubanDataSource(fetcher = MetadataFetcher { url, _ ->
            if (url.contains("/works")) HttpReply(200, works)
            else { infoGate.await(); HttpReply(200, """{"title":"回归影人"}""") }
        })
        val loading = launch { loadPersonPage(data, "1001", { infoShown = true }, { rendered.complete(Unit) }, { error -> throw AssertionError(error) }) }
        withTimeout(2500) { rendered.await() }
        loading.cancelAndJoin(); infoGate.complete(Unit); delay(30)
        assertFalse(infoShown)
    }
    @Test fun `optional information failure still allows the available works`() = runBlocking {
        var rendered = false
        var warned = false
        val data = DoubanDataSource(fetcher = MetadataFetcher { url, _ -> if (url.contains("/works")) HttpReply(200, works) else HttpReply(404, "{}") })
        withTimeout(2500) { loadPersonPage(data, "1001", { fail("Unexpected info") }, { rendered = it.items.isNotEmpty() }, { warned = true }) }
        assertTrue(rendered); assertTrue(warned)
    }
}
