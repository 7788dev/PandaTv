package app.panda.tv

import app.panda.tv.data.DataError
import app.panda.tv.data.DoubanDataSource
import app.panda.tv.data.HttpReply
import app.panda.tv.data.MetadataFetcher
import app.panda.tv.model.Json
import app.panda.tv.model.StateAction
import app.panda.tv.state.UserStore
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files

class UsageAuditProbeTest {
    private fun subject(id: String) = """{"id":"$id","title":"Audit title $id","type":"movie","genres":["剧情"],"year":"2023"}"""

    @Test
    fun detailFollowerInheritsCancelledLeader() = runBlocking {
        var subjectCalls = 0
        var activeWhenCancellationArrived = false
        val started = CompletableDeferred<Unit>()
        val source = DoubanDataSource(fetcher = MetadataFetcher { url, _ ->
            when {
                url.contains("/credits") -> HttpReply(200, """{"items":[]}""")
                url.contains("/photos") -> HttpReply(200, """{"photos":[]}""")
                ++subjectCalls == 1 -> { started.complete(Unit); awaitCancellation() }
                else -> HttpReply(200, subject("1"))
            }
        })
        val leader = launch { source.detail("db-1") }
        started.await()
        val follower = async {
            try { source.detail("db-1") }
            catch (cancelled: CancellationException) {
                activeWhenCancellationArrived = coroutineContext.isActive
                throw cancelled
            }
        }
        yield()
        leader.cancelAndJoin()
        try { withTimeout(1000L) { follower.await() } } catch (_: CancellationException) {}
        assertTrue(activeWhenCancellationArrived)
        assertTrue(follower.isCancelled)
        assertEquals(1, subjectCalls)
        val control = withTimeout(1500L) { source.detail("db-1") }
        assertEquals("db-1", control.id)
        assertEquals(2, subjectCalls)
        println("USAGE_AUDIT detail-cancellation activeFollower=$activeWhenCancellationArrived inheritedCancellation=${follower.isCancelled} recoveryControl=${control.id} calls=$subjectCalls")
    }

    @Test
    fun corruptUserFileSilentlyResetsAndNextWriteReplacesIt() {
        val directory = Files.createTempDirectory("panda-usage-corrupt-").toFile()
        val file = File(directory, "user-state.json")
        val original = """{"favorites":["db-1"],"history":[],"searches":["saved"],"settings":"""
        file.writeText(original, Charsets.UTF_8)
        val store = UserStore(file)
        assertTrue(store.get().favorites.isEmpty())
        assertEquals(original, file.readText(Charsets.UTF_8))
        store.dispatch(StateAction.ToggleFavorite("db-2"))
        val replaced = Json.parseObject(file.readText(Charsets.UTF_8))
        assertEquals(listOf("db-2"), Json.list(replaced["favorites"]))
        assertTrue(Json.list(replaced["searches"]).isEmpty())
        println("USAGE_AUDIT corrupt-user initialFavorites=0 nextWriteFavorites=${replaced["favorites"]} originalSavedIdentityLost=true path=${file.absolutePath}")
    }

    @Test
    fun storageFailureEscapesUserDispatch() {
        val directory = Files.createTempDirectory("panda-usage-write-").toFile()
        val parentBlocker = File(directory, "blocked-parent")
        parentBlocker.writeText("This is a file, so child writes must fail")
        val store = UserStore(File(parentBlocker, "user-state.json"))
        var thrown: Throwable? = null
        try { store.dispatch(StateAction.ToggleFavorite("db-1")) } catch (failure: Throwable) { thrown = failure }
        assertNotNull(thrown)
        assertTrue(store.get().favorites.isEmpty())
        println("USAGE_AUDIT failed-save escaped=${thrown!!.javaClass.name} inMemoryStatePreserved=true")
    }

    @Test
    fun optionalMetadataBlocksPrimaryDetail() = runBlocking {
        val gate = CompletableDeferred<Unit>()
        val baseReturned = CompletableDeferred<Unit>()
        var optionalRequests = 0
        val source = DoubanDataSource(fetcher = MetadataFetcher { url, _ ->
            if (url.contains("/credits") || url.contains("/photos")) {
                optionalRequests++
                gate.await()
                HttpReply(403, "{}")
            } else { baseReturned.complete(Unit); HttpReply(200, subject("1")) }
        })
        val pending = async { source.detail("db-1") }
        baseReturned.await()
        delay(600L)
        assertEquals(2, optionalRequests)
        assertFalse(pending.isCompleted)
        gate.complete(Unit)
        val item = pending.await()
        assertEquals("db-1", item.id)
        println("USAGE_AUDIT optional-detail baseReady=true at600MsCompleted=false optionalRequests=$optionalRequests afterRelease=${item.id}")
    }

    @Test
    fun oneUncachedFailureRejectsCachedLibrary() = runBlocking {
        val source = DoubanDataSource(fetcher = MetadataFetcher { url, _ ->
            if (url.contains("/search/movie")) HttpReply(200, """{"items":[${subject("1")},${subject("2")}],"total":2}""")
            else HttpReply(503, "{}")
        })
        val seeded = source.search("审查")
        assertEquals(2, seeded.size)
        var failure: DataError? = null
        try { source.byIds(listOf("db-1", "db-3", "db-2")) } catch (error: DataError) { failure = error }
        assertNotNull(failure)
        val surviving = source.byIds(listOf("db-1", "db-2"))
        assertEquals(2, surviving.size)
        println("USAGE_AUDIT partial-library seeded=2 mixedReadRejected=${failure!!.code} cachedOnly=${surviving.size}")
    }
}
