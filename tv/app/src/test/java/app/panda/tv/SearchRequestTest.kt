package app.panda.tv

import app.panda.tv.data.DataError
import app.panda.tv.data.DataErrorCode
import app.panda.tv.ui.awaitScreenRequest
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SearchRequestTest {
    @Test
    fun `a stalled metadata cleanup cannot prevent the search timeout from returning`() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val entered = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val result = scope.async {
            runCatching {
                awaitScreenRequest(scope, timeoutMs = 30L) {
                    withContext(NonCancellable) {
                        entered.complete(Unit)
                        release.await()
                        listOf("late")
                    }
                }
            }
        }
        try {
            withTimeout(1000L) { entered.await() }
            val failure = withTimeout(500L) { result.await() }.exceptionOrNull()
            assertTrue(failure is DataError)
            assertEquals(DataErrorCode.TIMEOUT, (failure as DataError).code)
            assertTrue(failure.retryable)
        } finally {
            release.complete(Unit)
            scope.cancel()
        }
    }

    @Test
    fun `cancelling an old search does not wait for its blocking metadata work`() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val entered = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val result = scope.async {
            awaitScreenRequest(scope) {
                withContext(NonCancellable) {
                    entered.complete(Unit)
                    release.await()
                    "late"
                }
            }
        }
        try {
            withTimeout(1000L) { entered.await() }
            result.cancel()
            withTimeout(500L) { result.join() }
            assertTrue(result.isCancelled)
        } finally {
            release.complete(Unit)
            scope.cancel()
        }
    }

    @Test
    fun `a completed search can still return a verified empty result`() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            assertEquals(emptyList<String>(), awaitScreenRequest(scope) { emptyList<String>() })
        } finally {
            scope.cancel()
        }
    }
}
