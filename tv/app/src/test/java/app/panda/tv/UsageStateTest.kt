package app.panda.tv

import app.panda.tv.model.StateAction
import app.panda.tv.data.DoubanDataSource
import app.panda.tv.data.HttpReply
import app.panda.tv.data.MetadataFetcher
import app.panda.tv.state.UserStore
import app.panda.tv.state.UserStateWriter
import app.panda.tv.data.DataError
import app.panda.tv.data.DataErrorCode
import app.panda.tv.model.Quality
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assert.assertFalse
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.concurrent.Executors

class UsageStateTest {
    @Test
    fun `a cancelled detail leader does not cancel a still active follower`() = runBlocking {
        var calls = 0
        val started = CompletableDeferred<Unit>()
        val source = DoubanDataSource(fetcher = MetadataFetcher { url, _ ->
            when {
                url.contains("/credits") -> HttpReply(200, """{"items":[]}""")
                url.contains("/photos") -> HttpReply(200, """{"photos":[]}""")
                ++calls == 1 -> { started.complete(Unit); awaitCancellation() }
                else -> HttpReply(200, """{"id":"1","title":"Title 1","type":"movie","genres":["剧情"],"year":"2023"}""")
            }
        })
        val leader = launch { source.detail("db-1") }
        started.await()
        val follower = async { source.detail("db-1") }
        yield()
        leader.cancelAndJoin()
        assertEquals("db-1", withTimeout(1500L) { follower.await() }.id)
        assertEquals(2, calls)
    }

    @Test
    fun `a damaged user file cannot be replaced by a new favorite action`() {
        val dir = Files.createTempDirectory("panda-tv-corrupt-red-").toFile()
        val file = File(dir, "user-state.json")
        val damaged = "{\"favorites\":[\"db-1\"],"
        file.writeText(damaged)
        val store = UserStore(file)
        assertThrows(Exception::class.java) { store.dispatch(StateAction.ToggleFavorite("db-2")) }
        assertEquals(damaged, file.readText())
    }

    @Test
    fun `a follower cancelling itself leaves its leader active and does not start another request`() = runBlocking {
        val started = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        var calls = 0
        val source = DoubanDataSource(fetcher = MetadataFetcher { url, _ ->
            if (url.contains("/credits")) HttpReply(200, """{"items":[]}""")
            else if (url.contains("/photos")) HttpReply(200, """{"photos":[]}""")
            else { calls++; started.complete(Unit); release.await(); HttpReply(200, """{"id":"1","title":"Title 1","type":"movie","genres":[]}""") }
        })
        val leader = async { source.detail("db-1") }
        started.await()
        val follower = async(start = CoroutineStart.UNDISPATCHED) { source.detail("db-1") }
        follower.cancelAndJoin()
        assertTrue(leader.isActive)
        assertEquals(1, calls)
        release.complete(Unit)
        assertEquals("db-1", withTimeout(1500L) { leader.await() }.id)
        assertEquals(1, calls)
    }

    @Test
    fun `normal detail errors are shared without a follower retry loop`() = runBlocking {
        val started = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        var calls = 0
        val source = DoubanDataSource(fetcher = MetadataFetcher { _, _ ->
            calls++; started.complete(Unit); release.await(); HttpReply(404, "{}")
        })
        val leader = async { runCatching { source.detail("db-1") }.exceptionOrNull() }
        started.await()
        val follower = async(start = CoroutineStart.UNDISPATCHED) { runCatching { source.detail("db-1") }.exceptionOrNull() }
        release.complete(Unit)
        assertEquals(DataErrorCode.NOT_FOUND, (leader.await() as DataError).code)
        assertEquals(DataErrorCode.NOT_FOUND, (follower.await() as DataError).code)
        assertEquals(2, calls)
    }

    @Test
    fun `explicit recovery uses a valid backup and keeps the damaged original bytes`() {
        val dir = Files.createTempDirectory("panda-tv-recovery-").toFile()
        val file = File(dir, "user-state.json")
        val store = UserStore(file)
        store.dispatch(StateAction.ToggleFavorite("db-1"))
        store.dispatch(StateAction.ToggleFavorite("db-2"))
        val damaged = "{\"favorites\":[\"db-1\"],\n损坏"
        file.writeText(damaged)
        val broken = UserStore(file)
        assertTrue(broken.recovery().needed)
        assertTrue(broken.recovery().canRestore)
        assertThrows(Exception::class.java) { broken.get() }
        assertEquals(listOf("db-1"), broken.recover(true).favorites)
        assertEquals(listOf("db-1"), UserStore(file).get().favorites)
        assertEquals(damaged, dir.listFiles()!!.first { it.name.contains(".corrupt-") }.readText())
        assertFalse(broken.recovery().needed)
    }

    @Test
    fun `a bad backup does not authorize replacing a damaged state and reset stays explicit`() {
        val dir = Files.createTempDirectory("panda-tv-reset-").toFile()
        val file = File(dir, "user-state.json").apply { writeText("{bad") }
        File(dir, "user-state.json.bak").writeText("also bad")
        val store = UserStore(file)
        assertFalse(store.recovery().canRestore)
        assertThrows(Exception::class.java) { store.recover(true) }
        assertEquals("{bad", file.readText())
        assertEquals(UserStore.initialUserState(), store.recover(false))
        assertEquals(UserStore.initialUserState(), UserStore(file).get())
    }

    @Test
    fun `the background writer retains committed state on failure and continues in serial order`() = runBlocking {
        val dir = Files.createTempDirectory("panda-tv-writer-").toFile()
        val file = File(dir, "user-state.json")
        val store = UserStore(file)
        store.dispatch(StateAction.ToggleFavorite("db-1"))
        val original = file.readBytes()
        val backup = File(dir, "user-state.json.bak")
        backup.delete(); backup.mkdir()
        val io = Executors.newSingleThreadExecutor { runnable -> Thread(runnable, "panda-state-test-io") }.asCoroutineDispatcher()
        val callbacks = Executors.newSingleThreadExecutor { runnable -> Thread(runnable, "panda-state-test-callback") }.asCoroutineDispatcher()
        val owner = CoroutineScope(SupervisorJob() + io)
        try {
            val writer = UserStateWriter(store, owner, io, callbacks)
            val failed = CompletableDeferred<Unit>()
            writer.dispatch({ StateAction.ToggleFavorite("db-2") }) { result ->
                try {
                    assertTrue(result.isFailure)
                    assertEquals("panda-state-test-callback", Thread.currentThread().name.substringBefore(" @coroutine#"))
                    assertEquals(listOf("db-1"), store.get().favorites)
                    assertTrue(original.contentEquals(file.readBytes()))
                    backup.delete()
                    failed.complete(Unit)
                } catch (error: Throwable) { failed.completeExceptionally(error) }
            }
            withTimeout(1500L) { failed.await() }
            val completed = CompletableDeferred<Unit>()
            val values = ArrayList<Boolean>()
            repeat(3) {
                writer.dispatch({ state ->
                    assertEquals("panda-state-test-io", Thread.currentThread().name.substringBefore(" @coroutine#"))
                    StateAction.UpdateSettings(autoNext = !state.settings.autoNext, quality = Quality.Q720P)
                }) { result ->
                    values.add(result.getOrThrow().settings.autoNext)
                    if (values.size == 3) completed.complete(Unit)
                }
            }
            withTimeout(2000L) { completed.await() }
            assertEquals(listOf(false, true, false), values)
            assertEquals(store.get(), UserStore(file).get())
        } finally { owner.cancel(); io.close(); callbacks.close() }
    }

    @Test
    fun `large library pages return cached rows without reading cold entries outside the page`() = runBlocking {
        var calls = 0
        val warnings = ArrayList<String>()
        val source = DoubanDataSource(fetcher = MetadataFetcher { url, _ ->
            calls++
            val id = Regex("/(\\d+)(?:\\?|$)").find(url)!!.groupValues[1]
            HttpReply(200, """{"id":"$id","title":"Title $id","type":"movie","genres":[]}""")
        }, onWarning = { warnings.add(it.code) })
        source.subject("db-1"); source.subject("db-3")
        val ids = (1..10000).map { "db-$it" }
        val first = source.libraryPage(ids, cachedOnly = true)
        assertEquals(listOf("db-1", "db-3"), first.items.map { it.id })
        assertEquals(28, first.pending.size)
        assertEquals("30", first.next)
        assertEquals(2, calls)
        val smaller = source.libraryPage(ids.take(2501), cachedOnly = true)
        assertEquals(first.items, smaller.items)
        assertEquals(2, calls)
    }

    @Test
    fun `cached library rows survive an uncached server failure`() = runBlocking {
        val warnings = ArrayList<String>()
        val source = DoubanDataSource(fetcher = MetadataFetcher { url, _ ->
            val id = Regex("/(\\d+)(?:\\?|$)").find(url)!!.groupValues[1]
            if (id == "2") HttpReply(503, "{}")
            else HttpReply(200, """{"id":"$id","title":"Title $id","type":"movie","genres":[]}""")
        }, onWarning = { warnings.add(it.code) })
        source.subject("db-1"); source.subject("db-3")
        val result = source.byIds(listOf("db-1", "db-2", "db-3"))
        assertEquals(listOf("db-1", "db-3"), result.map { it.id })
        assertTrue(warnings.contains("PARTIAL"))
    }

    @Test
    fun `leaving a library page stops its active workers and never starts the rest`() = runBlocking {
        var calls = 0
        val started = CompletableDeferred<Unit>()
        val source = DoubanDataSource(fetcher = MetadataFetcher { _, _ ->
            calls++; started.complete(Unit); awaitCancellation()
        })
        val request = async { source.libraryPage((1..10000).map { "db-$it" }) }
        started.await()
        request.cancelAndJoin()
        val stopped = calls
        delay(100L)
        assertEquals(stopped, calls)
        assertTrue(calls in 1..3)
    }
}
