package app.panda.tv.ui

import app.panda.tv.data.DataError
import app.panda.tv.data.DataErrorCode
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.withTimeout

suspend fun <Value> awaitScreenRequest(
    lifecycleScope: CoroutineScope,
    timeoutMs: Long = 25_000L,
    request: suspend () -> Value,
): Value {
    val pending = lifecycleScope.async(Dispatchers.IO) { request() }
    try {
        return withTimeout(timeoutMs) { pending.await() }
    } catch (timeout: TimeoutCancellationException) {
        throw DataError(DataErrorCode.TIMEOUT, "Screen request timed out", retryable = true)
    } finally {
        pending.cancel()
    }
}
