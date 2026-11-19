package app.panda.tv.playback

import app.panda.tv.net.PublicNetwork
import java.net.URI
import kotlin.math.abs
import kotlin.math.round

data class FilterResult(
    val text: String,
    val removedSegments: Int,
    val removedSeconds: Double,
    val reason: String,
    val evidence: List<String> = emptyList(),
)

object PlaylistFilter {
    private const val MAIN_SHARE = 0.8
    private const val MAX_RUN_SECONDS = 90.0
    private const val FINGERPRINT_TOLERANCE = 0.04

    private val KEY_BAD_RE = Regex("METHOD=(?:NONE|AES-128)(?:,|$)")
    private val COMPLEX_RE = Regex("^#EXT-X-(?:PART|PRELOAD-HINT|SKIP|MAP:)")
    private val MASTER_RE = Regex("^#EXT-X-(?:MEDIA:|STREAM-INF:)")
    private val ANCHORED_RE = Regex("^#EXT-X-(?:START|PROGRAM-DATE-TIME|DATERANGE|DISCONTINUITY-SEQUENCE):")
    private val SUBTITLE_RE = Regex("\\.(?:vtt|ttml)(?:\\?|$)", RegexOption.IGNORE_CASE)
    private val HEADER_RE = Regex("^#EXT(?:M3U|-X-(?:VERSION|PLAYLIST-TYPE|MEDIA-SEQUENCE|TARGETDURATION|INDEPENDENT-SEGMENTS))")
    private val IV_RE = Regex("IV=0x", RegexOption.IGNORE_CASE)
    private val SYNC_TRACK_RE = Regex("TYPE=(?:AUDIO|SUBTITLES)")
    private val URI_ATTR_RE = Regex("""URI="([^"]+)"""")

    private data class Segment(
        val prefix: List<String>,
        val uri: String,
        val url: URI,
        val duration: Double,
        val key: String?,
        val boundary: Boolean,
        val block: Int,
        var evidence: String? = null,
    )

    private data class BlockStats(var seconds: Double, val dirs: HashSet<String>)

    private fun directoryOf(url: URI): String {
        val host = url.host ?: ""
        val path = url.rawPath ?: "/"
        val idx = path.lastIndexOf('/')
        val dir = if (idx >= 0) path.substring(0, idx + 1) else "/"
        return host + dir
    }

    private fun isEncrypted(key: String?): Boolean =
        key != null && !key.contains("METHOD=NONE")

    private fun preserve(text: String, reason: String): FilterResult =
        FilterResult(text, 0, 0.0, reason, emptyList())

    fun hasSynchronizedTracks(text: String): Boolean =
        text.split(Regex("\\r?\\n")).any { l ->
            val t = l.trim()
            t.startsWith("#EXT-X-MEDIA:") && SYNC_TRACK_RE.containsMatchIn(t) && t.contains("URI=\"")
        }

    fun filterPlaylist(
        text: String,
        baseUrl: String,
        source: PlaySource,
        rules: SourceRules,
        preserveTimeline: Boolean = false,
    ): FilterResult {
        val original = if (text.isNotEmpty() && text[0] == '\uFEFF') text.substring(1) else text
        val lines = original.split(Regex("\\r?\\n")).map { it.trim() }
        if (preserveTimeline) return preserve(original, "synchronized-tracks")

        val guardReason = when {
            !lines.contains("#EXT-X-ENDLIST") -> "live-or-master"
            lines.any { it.startsWith("#EXT-X-KEY:") && !KEY_BAD_RE.containsMatchIn(it) } -> "encrypted"
            lines.any { it.startsWith("#EXT-X-SESSION-KEY:") } -> "encrypted"
            lines.any { MASTER_RE.containsMatchIn(it) } -> "master"
            lines.any { COMPLEX_RE.containsMatchIn(it) } -> "complex-timeline"
            lines.any { ANCHORED_RE.containsMatchIn(it) } -> "anchored-timeline"
            lines.any { it.startsWith("#EXT-X-BYTERANGE:") } -> "byte-range"
            lines.any { !it.startsWith("#") && SUBTITLE_RE.containsMatchIn(it) } -> "subtitles"
            else -> null
        }
        if (guardReason != null) return preserve(original, guardReason)

        val header = ArrayList<String>()
        val segments = ArrayList<Segment>()
        var pending = ArrayList<String>()
        var cue = false
        var armed = false
        var marker = false
        var boundary = false
        var block = 0
        var key: String? = null

        for (line in lines) {
            if (line.isEmpty()) continue
            if (line.startsWith("# ppvod-ad-injected")) {
                armed = true
                continue
            }
            if (line == "#EXT-X-DISCONTINUITY") {
                marker = armed
                armed = false
                boundary = true
                block++
                pending.add(line)
                continue
            }
            if (line == "#EXT-X-CUE-OUT" || line.startsWith("#EXT-X-CUE-OUT:")) {
                cue = true
                continue
            }
            if (line.startsWith("#EXT-X-CUE-OUT-CONT")) continue
            if (line.startsWith("#EXT-X-CUE-IN")) {
                cue = false
                continue
            }
            if (line == "#EXT-X-ENDLIST") continue
            if (line.startsWith("#EXT-X-KEY:")) {
                key = line
                continue
            }
            if (line.startsWith("#")) {
                if (HEADER_RE.containsMatchIn(line)) header.add(line) else pending.add(line)
                continue
            }
            val url = try {
                URI(PublicNetwork.resolveUrl(baseUrl, line))
            } catch (_: Exception) {
                return preserve(original, "invalid-uri")
            }
            val durationLine = pending.firstOrNull { it.startsWith("#EXTINF:") }
            val duration = durationLine?.substring(8)?.substringBefore(',')?.toDoubleOrNull() ?: Double.NaN
            if (!duration.isFinite() || duration <= 0.0) return preserve(original, "invalid-duration")
            val rawPath = url.rawPath ?: ""
            val evidence = when {
                cue -> "cue"
                marker -> "marker"
                source.adPaths.any { rawPath.startsWith(it) } -> "path"
                else -> null
            }
            segments.add(Segment(pending, line, url, duration, key, boundary, block, evidence))
            pending = ArrayList()
            boundary = false
        }

        if (cue) return preserve(original, "unclosed-ad-break")
        if (segments.size < 3) return preserve(original, "short-playlist")
        val total = segments.sumOf { it.duration }

        for (fp in source.fingerprints) {
            if (segments.size < fp.size) continue
            for (start in 0..(segments.size - fp.size)) {
                val end = start + fp.size
                if (!segments[start].boundary || (end < segments.size && !segments[end].boundary)) continue
                var match = true
                for (offset in fp.indices) {
                    if (abs(segments[start + offset].duration - fp[offset]) > FINGERPRINT_TOLERANCE) {
                        match = false
                        break
                    }
                }
                if (match) {
                    for (i in start until end) {
                        if (segments[i].evidence == null) segments[i].evidence = "fingerprint"
                    }
                }
            }
        }

        if (rules.foreignBlockMaxSeconds > 0.0) {
            val blocks = HashMap<Int, BlockStats>()
            val dirSeconds = HashMap<String, Double>()
            for (seg in segments) {
                val dir = directoryOf(seg.url)
                val b = blocks.getOrPut(seg.block) { BlockStats(0.0, HashSet()) }
                b.seconds += seg.duration
                b.dirs.add(dir)
                dirSeconds[dir] = (dirSeconds[dir] ?: 0.0) + seg.duration
            }
            val mainEntry = dirSeconds.entries.maxByOrNull { it.value }
            if (mainEntry != null && blocks.size > 1 && mainEntry.value >= total * MAIN_SHARE) {
                val mainDir = mainEntry.key
                for (seg in segments) {
                    val b = blocks[seg.block]!!
                    if (b.seconds <= rules.foreignBlockMaxSeconds && mainDir !in b.dirs) {
                        if (seg.evidence == null) seg.evidence = "foreign"
                    }
                }
            }
        }

        val dropped = segments.filter { it.evidence != null }
        if (dropped.isEmpty()) return preserve(original, "clean-or-unverified")
        if (dropped.any { isEncrypted(it.key) && !IV_RE.containsMatchIn(it.key!!) }) {
            return preserve(original, "encrypted-implicit-iv")
        }
        val removed = dropped.sumOf { it.duration }
        if (dropped.size == segments.size || removed > total * rules.maxDropRatio) {
            return preserve(original, "safety-limit")
        }
        var run = 0.0
        for (seg in segments) {
            run = if (seg.evidence != null) run + seg.duration else 0.0
            if (run > MAX_RUN_SECONDS) return preserve(original, "ad-block-too-long")
        }

        val output = ArrayList<String>(header.size + segments.size * 2 + 2)
        output.addAll(header)
        var removedPending = false
        var kept = false
        var currentKey: String? = null
        for (seg in segments) {
            if (seg.evidence != null) {
                removedPending = true
                continue
            }
            if (removedPending && kept && !seg.prefix.contains("#EXT-X-DISCONTINUITY")) {
                output.add("#EXT-X-DISCONTINUITY")
            }
            if (seg.key != currentKey) {
                output.add(seg.key ?: "#EXT-X-KEY:METHOD=NONE")
                currentKey = seg.key
            }
            output.addAll(seg.prefix)
            output.add(seg.uri)
            kept = true
            removedPending = false
        }
        output.addAll(pending)
        output.add("#EXT-X-ENDLIST")
        output.add("")

        val ev = dropped.mapNotNull { it.evidence }.distinct()
        return FilterResult(
            text = output.joinToString("\n"),
            removedSegments = dropped.size,
            removedSeconds = round(removed * 1000.0) / 1000.0,
            reason = "filtered",
            evidence = ev,
        )
    }

    /** Resolves relative segment/key/variant URIs to absolute http(s) URLs and registers each child URI. */
    fun absolutizePlaylist(
        text: String,
        baseUrl: String,
        onUri: (String) -> Unit = {},
    ): String {
        val clean = if (text.isNotEmpty() && text[0] == '\uFEFF') text.substring(1) else text
        fun resolveAndValidate(rawUri: String): String {
            val resolved = PublicNetwork.resolveUrl(baseUrl, rawUri)
            PublicNetwork.validatePublicUrl(resolved)
            onUri(resolved)
            return resolved
        }
        return clean.split(Regex("\\r?\\n")).joinToString("\n") { raw ->
            val line = raw.trim()
            when {
                line.isEmpty() -> ""
                line.startsWith("#") && !line.startsWith("#EXT") -> ""
                line.startsWith("#") -> URI_ATTR_RE.replace(line) { m ->
                    """URI="${resolveAndValidate(m.groupValues[1])}""""
                }
                else -> resolveAndValidate(line)
            }
        }
    }
}
