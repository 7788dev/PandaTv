package app.panda.tv.playback

data class DurationReading(val seconds: Double?, val source: String)

object DurationReader {
    fun hls(text: String): DurationReading {
        val lines = text.lineSequence().toList()
        if ("#EXT-X-ENDLIST" !in lines) return DurationReading(null, "missing")
        var total = 0.0
        var seen = false
        for (line in lines) {
            if (!line.startsWith("#EXTINF:")) continue
            val value = line.substring(8).substringBefore(',').trim().toDoubleOrNull() ?: continue
            if (!value.isFinite() || value <= 0.0) continue
            total += value
            seen = true
        }
        return if (seen) DurationReading(total, "hls-extinf") else DurationReading(null, "missing")
    }

    fun mp4(head: ByteArray): DurationReading {
        val index = indexOf(head, MVHD)
        if (index < 4 || index + 8 > head.size) return DurationReading(null, "missing")
        val version = head[index + 4].toInt() and 0xff
        if (version != 0 && version != 1) return DurationReading(null, "missing")
        val base = index + 8
        val durationEnd = base + if (version == 1) 28 else 16
        if (durationEnd > head.size) return DurationReading(null, "missing")
        val timescale = if (version == 1) u32(head, base + 16) else u32(head, base + 8)
        val duration = if (version == 1) u64(head, base + 20) else u32(head, base + 12)
        if (timescale <= 0L || duration <= 0L) return DurationReading(null, "missing")
        return DurationReading(duration.toDouble() / timescale.toDouble(), "mp4-moov")
    }

    private val MVHD = "mvhd".toByteArray(Charsets.US_ASCII)

    private fun indexOf(bytes: ByteArray, needle: ByteArray): Int {
        outer@ for (index in 0..bytes.size - needle.size) {
            for (offset in needle.indices) {
                if (bytes[index + offset] != needle[offset]) continue@outer
            }
            return index
        }
        return -1
    }

    private fun u32(bytes: ByteArray, offset: Int): Long {
        if (offset < 0 || offset + 4 > bytes.size) return -1L
        return ((bytes[offset].toLong() and 0xff) shl 24) or
            ((bytes[offset + 1].toLong() and 0xff) shl 16) or
            ((bytes[offset + 2].toLong() and 0xff) shl 8) or
            (bytes[offset + 3].toLong() and 0xff)
    }

    private fun u64(bytes: ByteArray, offset: Int): Long {
        val high = u32(bytes, offset)
        val low = u32(bytes, offset + 4)
        if (high < 0L || low < 0L) return -1L
        return (high shl 32) or low
    }
}
