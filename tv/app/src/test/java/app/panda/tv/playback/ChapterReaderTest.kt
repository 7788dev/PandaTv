package app.panda.tv.playback

import app.panda.tv.model.TimeRange
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.nio.ByteBuffer

class ChapterReaderTest {
    private val playlist = """#EXTM3U
#EXT-X-PROGRAM-DATE-TIME:2026-11-26T23:59:58.000+08:00
#EXT-X-DATERANGE:ID="1",CLASS="opening",START-DATE="2026-11-26T15:59:59.500Z",DURATION=2.5
#EXTINF:5,
first.ts
#EXT-X-DATERANGE:ID="2",X-TITLE="片尾",START-DATE="2026-11-27T00:00:05+08:00",END-DATE="2026-11-27T00:00:08+08:00"
#EXTINF:5,
second.ts
#EXT-X-ENDLIST"""

    @Test fun hlsMapsExplicitWallTimeChaptersAcrossMidnight() {
        assertEquals(ChapterMarks(TimeRange(1.5, 4.0), 7.0), ChapterReader.hls(playlist))
        assertNull(ChapterReader.hls(playlist.replace("00:00:08+", "00:00:07+")).outro)
        assertEquals(ChapterMarks(), ChapterReader.hls(playlist.replace("#EXT-X-ENDLIST", "")))
        assertEquals(ChapterMarks(), ChapterReader.hls(playlist.replace("#EXT-X-PROGRAM-DATE-TIME", "#unknown")))
    }

    @Test fun manualTimesFollowOnlyValidEpisodeDurations() {
        val marks = ChapterMarks(TimeRange(2.0, 4.0), 90.0)
        assertEquals(ChapterMarks(TimeRange(0.0, 10.0), 80.0), marks.withManual(10.0, 20.0, 100.0))
        assertEquals(ChapterMarks(), marks.withManual(10.0, 20.0, 3.0))
        assertNull(ChapterMarks().withManual(60.0, 60.0, 100.0).outro)
    }

    private fun box(type: String, bytes: ByteArray): ByteArray = ByteBuffer.allocate(8 + bytes.size)
        .putInt(bytes.size + 8).put(type.toByteArray(Charsets.US_ASCII)).put(bytes).array()

    @Test fun mp4FindsTailChaptersWithoutReadingTheWholeVideo() = runBlocking {
        val buffer = ByteArrayOutputStream()
        DataOutputStream(buffer).use { data ->
            data.writeInt(0x01000000)
            data.writeInt(0)
            data.writeByte(4)
            for ((second, name) in listOf(0 to "Opening", 12 to "剧情", 75 to "第二幕", 85 to "End Credits")) {
                val title = name.toByteArray(Charsets.UTF_8)
                data.writeLong(second * 10_000_000L)
                data.writeByte(title.size)
                data.write(title)
            }
        }
        val body = box("ftyp", "isom".toByteArray()) + box("mdat", ByteArray(50_000)) +
            box("moov", box("udta", box("chpl", buffer.toByteArray())))
        val reads = mutableListOf<Long>()
        val result = ChapterReader.mp4 { offset, count ->
            reads.add(offset)
            body.copyOfRange(offset.toInt(), minOf(body.size, offset.toInt() + count))
        }
        assertEquals(ChapterMarks(TimeRange(0.0, 12.0), 85.0), result)
        assertEquals(2, reads.size)
        assertTrue(reads.last() >= 50_000)
    }

    @Test fun unmarkedAndTruncatedMp4HaveNoGuessedChapters() = runBlocking {
        assertEquals(ChapterMarks(), ChapterReader.mp4 { _, _ -> ByteArray(5) })
        assertEquals(ChapterMarks(), ChapterReader.mp4 { _, _ -> byteArrayOf(0, 0, 0, 1) + "moov".toByteArray() })
    }
}
