package app.panda.tv.playback

import kotlinx.coroutines.CancellationException
import org.junit.Assert.*
import org.junit.Test
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicInteger

class MediaRequestCancellationTest {
    @Test fun `cancel disconnects registered requests once and closes a late response`() {
        val cancellation = MediaRequestCancellation()
        val disconnected = AtomicInteger()
        val (response, stream) = admissionResponse("https://a.example.org/first.ts", disconnected = disconnected)
        cancellation.trackResponse(response)
        cancellation.cancel(); cancellation.cancel()
        assertTrue(stream.closed); assertEquals(1, disconnected.get())
        val (late, lateStream) = admissionResponse("https://a.example.org/late.ts")
        val result = runCatching { cancellation.trackResponse(late) }
        assertTrue(result.exceptionOrNull() is CancellationException)
        assertTrue(lateStream.closed)
    }
    @Test fun `one failed disconnect does not skip the remaining request releases`() {
        val cancellation = MediaRequestCancellation()
        val bad = object : HttpURLConnection(URL("https://a.example.org/first.ts")) {
            override fun connect() {}
            override fun usingProxy() = false
            override fun disconnect() { throw IllegalStateException("Already disconnected") }
        }
        cancellation.trackConnection(bad)
        val (response, stream) = admissionResponse("https://b.example.org/first.ts")
        cancellation.trackResponse(response)
        cancellation.cancel()
        assertTrue(cancellation.cancelled)
        assertTrue(stream.closed)
    }
}
