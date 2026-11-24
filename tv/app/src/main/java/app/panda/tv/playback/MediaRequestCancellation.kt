package app.panda.tv.playback

import app.panda.tv.net.PublicResponse
import kotlinx.coroutines.CancellationException
import java.net.HttpURLConnection

/** Owns connections even while Java's blocking header/read calls have not returned. */
internal class MediaRequestCancellation {
    private val lock = Any()
    private val releases = ArrayList<() -> Unit>()
    @Volatile var cancelled = false
        private set

    fun trackConnection(connection: HttpURLConnection) = track { connection.disconnect() }
    fun trackResponse(response: PublicResponse) = track { response.close() }

    private fun track(release: () -> Unit) {
        val late = synchronized(lock) {
            if (cancelled) true else { releases.add(release); false }
        }
        if (late) {
            runCatching(release)
            throw CancellationException("请求已取消")
        }
    }

    fun cancel() {
        val pending = synchronized(lock) {
            if (cancelled) return
            cancelled = true
            releases.toList().also { releases.clear() }
        }
        // An already closed socket must not prevent the other requests being released.
        pending.forEach { runCatching(it) }
    }
}
