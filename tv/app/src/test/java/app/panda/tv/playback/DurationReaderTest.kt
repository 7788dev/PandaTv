package app.panda.tv.playback

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DurationReaderTest {
    @Test
    fun `adds every EXTINF value`() {
        val reading = DurationReader.hls("#EXTM3U\n#EXTINF:10,\na.ts\n#EXTINF:12.5,\nb.ts\n#EXT-X-ENDLIST\n")
        assertEquals("hls-extinf", reading.source)
        assertEquals(22.5, reading.seconds!!, 1e-9)
    }

    @Test
    fun `a playlist without segments has no duration`() {
        val reading = DurationReader.hls("#EXTM3U\n#EXT-X-ENDLIST\n")
        assertNull(reading.seconds)
        assertEquals("missing", reading.source)
    }

    @Test
    fun `a rolling live playlist window has no episode duration`() {
        val reading = DurationReader.hls(
            "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:100\n#EXTINF:6,\na.ts\n#EXTINF:6,\nb.ts\n",
        )
        assertNull(reading.seconds)
        assertEquals("missing", reading.source)
    }

    @Test
    fun `reads a version 0 mvhd box`() {
        val head = ByteArray(40)
        "mvhd".toByteArray(Charsets.US_ASCII).copyInto(head, 4)
        putU32(head, 20, 1_000)
        putU32(head, 24, 120_000)
        val reading = DurationReader.mp4(head)
        assertEquals("mp4-moov", reading.source)
        assertEquals(120.0, reading.seconds!!, 1e-9)
    }

    @Test
    fun `reads a version 1 mvhd box`() {
        val head = ByteArray(48)
        "mvhd".toByteArray(Charsets.US_ASCII).copyInto(head, 4)
        head[8] = 1
        putU32(head, 28, 1_000)
        putU64(head, 32, 120_000)
        val reading = DurationReader.mp4(head)
        assertEquals(120.0, reading.seconds!!, 1e-9)
    }

    @Test
    fun `incomplete version 0 and 1 mvhd boxes remain missing`() {
        val sizes = mapOf(0 to 28, 1 to 40)
        for ((version, required) in sizes) {
            val complete = ByteArray(required)
            "mvhd".toByteArray(Charsets.US_ASCII).copyInto(complete, 4)
            complete[8] = version.toByte()
            if (version == 0) {
                putU32(complete, 20, 1_000)
                putU32(complete, 24, 120_000)
            } else {
                putU32(complete, 28, 1_000)
                putU64(complete, 32, 120_000)
            }
            for (length in 0 until required) {
                val reading = DurationReader.mp4(complete.copyOf(length))
                assertNull("version $version, prefix $length", reading.seconds)
                assertEquals("missing", reading.source)
            }
            assertEquals(120.0, DurationReader.mp4(complete).seconds!!, 1e-9)
        }
    }

    @Test
    fun `an unsupported mvhd version is missing`() {
        val head = ByteArray(40)
        "mvhd".toByteArray(Charsets.US_ASCII).copyInto(head, 4)
        head[8] = 2
        assertNull(DurationReader.mp4(head).seconds)
    }

    @Test
    fun `a header without moov stays missing`() {
        val reading = DurationReader.mp4(ByteArray(16).also {
            "ftypisom".toByteArray(Charsets.US_ASCII).copyInto(it, 4)
        })
        assertNull(reading.seconds)
        assertEquals("missing", reading.source)
    }

    private fun putU32(bytes: ByteArray, offset: Int, value: Long) {
        bytes[offset] = (value shr 24).toByte()
        bytes[offset + 1] = (value shr 16).toByte()
        bytes[offset + 2] = (value shr 8).toByte()
        bytes[offset + 3] = value.toByte()
    }

    private fun putU64(bytes: ByteArray, offset: Int, value: Long) {
        putU32(bytes, offset, value shr 32)
        putU32(bytes, offset + 4, value and 0xffffffffL)
    }
}
