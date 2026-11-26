package app.panda.tv.playback

import app.panda.tv.model.TimeRange
import java.nio.ByteBuffer
import java.text.SimpleDateFormat
import java.util.Locale

data class ChapterMarks(val intro: TimeRange? = null, val outro: Double? = null) {
    fun withManual(introEnd: Double?, outroLength: Double?, duration: Double): ChapterMarks {
        val opening = introEnd?.takeIf { it > 0 && it < duration }?.let { TimeRange(0.0, it) }
            ?: intro?.takeIf { it.start >= 0 && it.start < it.end && it.end < duration }
        val closing = outroLength?.takeIf { it > 0 && it < duration }?.let { duration - it } ?: outro?.takeIf { it > 0 && it < duration }
        return ChapterMarks(opening, closing?.takeIf { it >= (opening?.end ?: 0.0) })
    }
}

object ChapterReader {
    private val titles = Regex("""(?:^|,)([A-Z0-9-]+)=("([^"]*)"|[^,]+)""")
    private val timestamp = Regex("""^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$""")
    private fun epoch(value: String?): Double? {
        val m = timestamp.matchEntire(value.orEmpty()) ?: return null
        val fmt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ssZ", Locale.US).apply { isLenient = false }
        val zone = if (m.groupValues[3] == "Z") "+0000" else m.groupValues[3].replace(":", "")
        val sec = runCatching { fmt.parse(m.groupValues[1] + zone)?.time }.getOrNull() ?: return null
        return sec / 1000.0 + ("0." + m.groupValues[2]).toDouble()
    }

    private fun kind(label: String?): String? = when (label?.trim()?.lowercase(Locale.ROOT)) {
        "intro", "opening", "opening credits", "片头", "片头曲", "op" -> "intro"
        "outro", "credits", "closing credits", "end credits", "片尾", "片尾曲", "ed" -> "outro"
        else -> null
    }

    fun hls(text: String): ChapterMarks {
        if ("#EXT-X-DATERANGE:" !in text || "#EXT-X-ENDLIST" !in text) return ChapterMarks()
        val anchors = ArrayList<Pair<Double, Double>>()
        val ranges = ArrayList<Map<String, String>>()
        var duration = 0.0
        for (raw in text.lineSequence()) {
            val line = raw.trim()
            when {
                line.startsWith("#EXT-X-PROGRAM-DATE-TIME:") -> epoch(line.substringAfter(':'))?.let { anchors.add(it to duration) }
                line.startsWith("#EXTINF:") -> duration += line.substringAfter(':').substringBefore(',').toDoubleOrNull()
                    ?.takeIf { it.isFinite() && it > 0.0 } ?: return ChapterMarks()
                line.startsWith("#EXT-X-DATERANGE:") -> ranges.add(titles.findAll(line.substringAfter(':')).associate {
                    it.groupValues[1] to it.groupValues[2].removeSurrounding("\"")
                })
            }
        }
        var intro: TimeRange? = null
        var outro: Double? = null
        for (range in ranges) {
            val type = kind(range["X-TITLE"]) ?: kind(range["CLASS"]?.substringAfterLast('.')) ?: continue
            val date = epoch(range["START-DATE"]) ?: continue
            val anchor = anchors.lastOrNull { it.first <= date } ?: continue
            val start = date - anchor.first + anchor.second
            if (start < 0 || start >= duration) continue
            val length = epoch(range["END-DATE"])?.let { it - date } ?: range["DURATION"]?.toDoubleOrNull()
            if (length != null && (!length.isFinite() || length <= 0 || start + length > duration + 0.1)) continue
            if (type == "intro" && length != null && start + length < duration) intro = TimeRange(start, start + length)
            if (type == "outro" && start > 0 && (length == null || start + length >= duration - 0.1)) outro = start
        }
        return ChapterMarks(intro, outro)
    }

    /** Follow MP4 box sizes, including an mdat before moov. Only read atom headers and chapter metadata. */
    suspend fun mp4(read: suspend (Long, Int) -> ByteArray): ChapterMarks {
        var windowStart = -1L
        var window = ByteArray(0)
        var requests = 0
        suspend fun bytes(offset: Long, n: Int): ByteBuffer? {
            if (offset < 0 || offset > Long.MAX_VALUE - n) return null
            if (windowStart < 0 || offset < windowStart || offset - windowStart > window.size.toLong() - n) {
                if (++requests > 12) return null
                window = read(offset, maxOf(8192, n))
                windowStart = offset
            }
            val i = (offset - windowStart).toInt()
            if (i > window.size - n) return null
            return ByteBuffer.wrap(window, i, n).slice()
        }
        suspend fun find(start: Long, end: Long, wanted: String): Pair<Long, Long>? {
            var p = start
            repeat(128) {
                if (end - p < 8) return null
                val h = bytes(p, 8) ?: return null
                val size = h.int.toLong() and 0xffffffffL
                val type = ByteArray(4).also { h.get(it) }.toString(Charsets.US_ASCII)
                val header = if (size == 1L) 16L else 8L
                val length = when (size) { 0L -> end - p; 1L -> bytes(p + 8, 8)?.long ?: return null; else -> size }
                if (length < header || length > end - p) return null
                if (type == wanted) return (p + header) to (p + length)
                p += length
            }
            return null
        }
        val movie = find(0, Long.MAX_VALUE, "moov") ?: return ChapterMarks()
        val user = find(movie.first, movie.second, "udta") ?: return ChapterMarks()
        val box = find(user.first, user.second, "chpl") ?: return ChapterMarks()
        val size = box.second - box.first
        if (size !in 5L..68_000L) return ChapterMarks()
        val data = bytes(box.first, size.toInt()) ?: return ChapterMarks()
        val version = data.get().toInt()
        if (version !in 0..1 || version == 1 && size < 9) return ChapterMarks()
        data.position(if (version == 1) 8 else 4)
        val count = data.get().toInt() and 255
        val chapters = mutableListOf<Pair<Double, String?>>()
        repeat(count) {
            if (data.remaining() < 9) return ChapterMarks()
            val seconds = data.long / 10_000_000.0
            val n = data.get().toInt() and 255
            if (data.remaining() < n || seconds < 0 || chapters.lastOrNull()?.let { it.first >= seconds } == true) return ChapterMarks()
            val title = ByteArray(n).also { data.get(it) }.toString(Charsets.UTF_8)
            chapters.add(seconds to kind(title))
        }
        val intro = chapters.zipWithNext().firstOrNull { it.first.second == "intro" }?.let { TimeRange(it.first.first, it.second.first) }
        return ChapterMarks(intro, chapters.lastOrNull()?.takeIf { it.second == "outro" && it.first > 0 }?.first)
    }
}
