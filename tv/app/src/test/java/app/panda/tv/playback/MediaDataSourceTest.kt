package app.panda.tv.playback

import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import org.junit.Assert.*
import org.junit.Test
import java.io.EOFException

@OptIn(UnstableApi::class)
class MediaDataSourceTest {
    // Inject only the received transport state: the read/close implementation is the production DataSource.
    private fun source(remaining: Long): Pair<PandaMediaDataSource, ObservedStream> {
        val rules = admissionRules(listOf("a"))
        val source = PandaMediaDataSource(WarmMediaCache(rules), rules)
        val (response, stream) = admissionResponse("https://a.media.example.org/first.ts", ByteArray(0), length = remaining)
        source.javaClass.getDeclaredField("response").apply { isAccessible = true }.set(source, response)
        source.javaClass.getDeclaredField("streamBytesLeft").apply { isAccessible = true }.setLong(source, remaining)
        return source to stream
    }
    @Test fun `premature EOF is a recoverable IO error when the upstream declared more bytes`() {
        val (source, stream) = source(100)
        try {
            val result = runCatching { source.read(ByteArray(16), 0, 16) }
            assertTrue(result.exceptionOrNull() is EOFException)
        } finally { source.close() }
        assertTrue(stream.closed)
        assertEquals(C.RESULT_END_OF_INPUT, source.read(ByteArray(16), 0, 16))
    }
    @Test fun `unknown-length and fully consumed responses still end normally`() {
        for (length in listOf(-1L, 0L)) {
            val (source, stream) = source(length)
            try { assertEquals(C.RESULT_END_OF_INPUT, source.read(ByteArray(16), 0, 16)) }
            finally { source.close() }
            assertTrue(stream.closed)
        }
    }
}
