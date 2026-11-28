package app.panda.tv.model

import java.util.Calendar
import java.util.Locale
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToLong

data class EpisodeRange(val from: Int, val to: Int, val label: String)
data class HistoryGroup(val label: String, val items: List<HistoryEntry>)

object Rules {
    fun isSeries(it: MediaItem): Boolean = (it.episodes ?: 0) > 0

    fun episodeCount(it: MediaItem): Int = it.episodes ?: 1

    fun playableEpisodes(item: MediaItem, from: Int = 1, to: Int = episodeCount(item)): List<Int> =
        item.episodeNumbers?.filter { it in from..to } ?: (from..to).toList()

    fun nextEpisode(item: MediaItem, current: Int): Int? {
        item.episodeNumbers?.let { return it.firstOrNull { number -> number > current } }
        return (current + 1).takeIf { it <= episodeCount(item) }
    }

    fun episodeToPlay(item: MediaItem, preferred: Int): Int {
        item.episodeNumbers?.let { numbers -> return numbers.firstOrNull { it >= preferred } ?: numbers.lastOrNull() ?: 1 }
        return min(preferred, episodeCount(item))
    }

    fun scoreText(it: MediaItem): String? {
        val s = it.score ?: return null
        if (s <= 0.0 || !s.isFinite()) return null
        return String.format(Locale.US, "%.1f", s)
    }

    fun statusText(it: MediaItem): String? {
        if (!it.status.isNullOrEmpty()) return it.status
        val rt = it.runtime ?: return null
        if (rt <= 0) return null
        return Copy.fmt(Copy.Status.MINUTES, "n" to rt)
    }

    fun episodeLabel(it: MediaItem, n: Int): String =
        Copy.fmt(Copy.Status.EPISODE, "n" to n, "unit" to (it.unit ?: "集"))

    fun episodeHeading(it: MediaItem, n: Int): String? {
        if (!isSeries(it)) return null
        val epTitle = it.episodeTitles?.getOrNull(n - 1)?.takeIf { s -> s.isNotEmpty() }
        val base = episodeLabel(it, n)
        return if (epTitle != null) "$base · $epTitle" else base
    }

    fun cardSub(it: MediaItem): String? {
        if (!it.tagline.isNullOrEmpty()) return it.tagline
        return if (it.genres.isNotEmpty()) it.genres.joinToString(" / ") else null
    }

    fun wideImage(it: MediaItem): String? = it.backdrop ?: it.poster

    fun metaParts(it: MediaItem, region: Boolean = false, genres: Int = 2): List<String> {
        val parts = ArrayList<String>(4)
        it.year?.let { if (it > 0) parts.add(it.toString()) }
        if (region && !it.region.isNullOrEmpty()) parts.add(it.region)
        if (it.genres.isNotEmpty()) parts.add(it.genres.take(genres).joinToString(" / "))
        statusText(it)?.let { parts.add(it) }
        return parts
    }

    fun rankSub(it: MediaItem): String? {
        val parts = listOfNotNull(it.genres.firstOrNull(), it.year?.toString())
        return if (parts.isEmpty()) null else parts.joinToString(" · ")
    }

    fun avatarText(name: String): String {
        if (name.isEmpty()) return ""
        val cp = name.codePointAt(0)
        return String(Character.toChars(cp))
    }

    fun isFinished(position: Double, duration: Double): Boolean =
        duration > 0.0 && position / duration > Constants.FINISHED_RATIO

    fun isFinished(h: HistoryEntry): Boolean = isFinished(h.position, h.duration)

    fun continuing(history: List<HistoryEntry>): List<HistoryEntry> =
        history.filter { !isFinished(it) }

    fun progressPercent(position: Double, duration: Double): Int {
        if (duration <= 0.0) return 0
        val pct = Math.round((position / duration) * 100.0).toInt()
        return min(100, max(0, pct))
    }

    fun progressPercent(h: HistoryEntry): Int = progressPercent(h.position, h.duration)

    fun progressText(it: MediaItem, h: HistoryEntry): String {
        val minutes = max(1L, ((h.duration - h.position) / 60.0).roundToLong())
        val rest = if (isFinished(h)) Copy.Status.FINISHED else Copy.fmt(Copy.Status.REMAINING, "n" to minutes)
        return if (isSeries(it)) "${episodeLabel(it, h.episode)} · $rest" else rest
    }

    fun playLabel(it: MediaItem, h: HistoryEntry?): String {
        if (h == null) return Copy.Action.PLAY
        if (isSeries(it)) return Copy.fmt(Copy.Action.RESUME_EPISODE, "n" to episodeToPlay(it, h.episode), "unit" to (it.unit ?: "集"))
        return if (isFinished(h)) Copy.Action.PLAY else Copy.Action.RESUME
    }

    fun resumePosition(h: HistoryEntry?, episode: Int): Double =
        if (h != null && h.episode == episode && !isFinished(h)) h.position else 0.0

    fun historyRecord(
        id: String,
        episode: Int,
        position: Double,
        duration: Double,
        next: Int?,
    ): HistoryEntry {
        return if (next != null && isFinished(position, duration)) {
            HistoryEntry(id, next, 0.0, 0.0, 0L)
        } else {
            HistoryEntry(id, episode, floor(position), duration, 0L)
        }
    }

    fun groupHistory(history: List<HistoryEntry>, now: Long = System.currentTimeMillis()): List<HistoryGroup> {
        val cal = Calendar.getInstance().apply {
            timeInMillis = now
            set(Calendar.HOUR_OF_DAY, 0)
            set(Calendar.MINUTE, 0)
            set(Calendar.SECOND, 0)
            set(Calendar.MILLISECOND, 0)
        }
        val today = cal.timeInMillis
        val day = 86_400_000L
        return listOf(
            HistoryGroup(Copy.Me.TODAY, history.filter { it.at >= today }),
            HistoryGroup(Copy.Me.YESTERDAY, history.filter { it.at < today && it.at >= today - day }),
            HistoryGroup(Copy.Me.EARLIER, history.filter { it.at < today - day }),
        ).filter { it.items.isNotEmpty() }
    }

    fun episodeRanges(count: Int, numbers: List<Int>? = null): List<EpisodeRange> {
        val ranges = ArrayList<EpisodeRange>()
        var from = 1
        while (from <= count) {
            val to = min(count, from + Constants.EPISODE_RANGE_SIZE - 1)
            if (numbers == null || numbers.any { it in from..to }) {
                ranges.add(EpisodeRange(from, to, Copy.fmt(Copy.Status.RANGE, "a" to from, "b" to to)))
            }
            from += Constants.EPISODE_RANGE_SIZE
        }
        return ranges
    }

    fun rangeOf(ranges: List<EpisodeRange>, episode: Int?): EpisodeRange? =
        ranges.firstOrNull { episode != null && episode in it.from..it.to } ?: ranges.firstOrNull()

    fun clock(seconds: Double): String {
        val sec = if (seconds.isFinite() && seconds > 0.0) seconds.toLong() else 0L
        val h = sec / 3600L
        val m = (sec / 60L) % 60L
        val s = sec % 60L
        return if (h > 0) String.format(Locale.US, "%d:%02d:%02d", h, m, s)
        else String.format(Locale.US, "%02d:%02d", m, s)
    }

    fun speedLabel(speed: Double): String {
        val text = if (speed % 1.0 == 0.0) String.format(Locale.US, "%.1f", speed) else speed.toString()
        return Copy.fmt(Copy.Player.TIMES, "n" to text)
    }

    fun endPosition(playback: Playback?, duration: Double, settings: Settings): Double {
        val outro = playback?.outro
        return if (settings.skipIntro && outro != null && outro < duration) outro else duration
    }

    fun startPosition(playback: Playback?, settings: Settings): Double {
        val intro = playback?.intro
        return if (settings.skipIntro && intro != null && intro.start <= 0.0) intro.end else 0.0
    }

    fun showSkipIntro(position: Double, playback: Playback?, settings: Settings): Boolean {
        val intro = playback?.intro ?: return false
        return !settings.skipIntro &&
            position >= intro.start + Constants.SKIP_EDGE_SECONDS &&
            position < intro.end - Constants.SKIP_EDGE_SECONDS
    }

    fun upNextSeconds(
        position: Double,
        end: Double,
        hasNext: Boolean,
        autoNext: Boolean,
        cancelled: Boolean,
    ): Int? {
        val left = end - position
        if (!hasNext || !autoNext || cancelled || left <= 0.0 || left > Constants.UPNEXT_SECONDS) return null
        return max(1, ceil(left).toInt())
    }
}
