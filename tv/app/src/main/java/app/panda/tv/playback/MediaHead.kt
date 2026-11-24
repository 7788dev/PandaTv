package app.panda.tv.playback

/** A bounded signature check; neither codecs nor a tail-positioned movie index affect it. */
object MediaHead {
    fun isMp4Head(head: ByteArray): Boolean {
        fun unsigned32(at: Int): Long = (0 until 4).fold(0L) { value, i ->
            (value shl 8) or (head[at + i].toLong() and 0xffL)
        }
        var at = 0
        while (at + 8 <= head.size) {
            val shortSize = unsigned32(at)
            val type = String(head, at + 4, 4, Charsets.US_ASCII)
            val header = if (shortSize == 1L) 16 else 8
            if (at + header > head.size) return false
            val size = if (shortSize == 1L) unsigned32(at + 8) * 4_294_967_296L + unsigned32(at + 12) else shortSize
            if (size < 0L || size > 9_007_199_254_740_991L || (size != 0L && size < header)) return false
            if (type == "ftyp") return size >= header + 8 && at + header + 8 <= head.size
            if (type in listOf("moov", "mdat", "moof")) return (size == 0L || size > header) && at + header < head.size
            if (type !in listOf("free", "wide", "skip", "uuid") || size == 0L || at + size > head.size) return false
            at += size.toInt()
        }
        return false
    }
}
