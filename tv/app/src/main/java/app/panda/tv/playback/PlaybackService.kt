package app.panda.tv.playback

import app.panda.tv.model.Adult
import app.panda.tv.model.Availability
import app.panda.tv.model.Copy
import app.panda.tv.model.Json
import app.panda.tv.model.MediaItem
import app.panda.tv.model.MediaType
import app.panda.tv.model.PlaySources
import app.panda.tv.model.Playback
import app.panda.tv.model.Quality
import app.panda.tv.model.Rules
import app.panda.tv.model.SourceOption
import app.panda.tv.data.Taxonomy
import app.panda.tv.net.PublicNetwork
import app.panda.tv.state.SourceHealthStore
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import java.net.URI
import java.net.URLEncoder
import java.text.Normalizer
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.abs
import kotlin.math.max

data class Episode(
    val title: String,
    val url: String,
    val format: String, // "hls" | "mp4"
    val number: Int? = null,
)

data class Line(
    val name: String,
    val episodes: List<Episode>,
)

data class WorkHints(
    val single: Boolean? = null,
    val aliases: List<String>? = null,
    val totalEpisodes: Int? = null,
)

data class TitleKey(val base: String, val season: Int, val dubbed: Boolean)
data class EpisodeRange(val name: String, val first: Int, val last: Int)
data class RecordMatch(val range: EpisodeRange? = null, val weak: Boolean = false)
data class Issue(val date: String? = null, val rest: String)
data class Numbering(
    val byNumber: Map<Int, Episode>,
    val numeric: Boolean,
    val titled: Boolean,
    val count: Int,
)

data class ManifestVariant(
    val url: String,
    val quality: Quality? = null,
    val bandwidth: Int,
)

data class Candidate(
    val source: PlaySource,
    val vodId: String,
    val lines: List<Line>,
    val dubbed: Boolean,
    val weak: Boolean,
    val run: Int? = null,
)

data class RawVod(
    val vodId: String?,
    val vodName: String?,
    val vodYear: String?,
    val typeName: String?,
    val vodPlayFrom: String?,
    val vodPlayUrl: String?,
    val vodArea: String? = null,
)

object PlaybackMatchers {
    private val LANGUAGE_RE = Regex("(?:国语版?|普通话版?|粤语版?|英语版?|日语版?|韩语版?|泰语版?|中字|双语|高清|完整版|未删减版)$")
    private val CJK_DIGIT = mapOf('零' to 0, '一' to 1, '二' to 2, '两' to 2, '三' to 3, '四' to 4, '五' to 5, '六' to 6, '七' to 7, '八' to 8, '九' to 9)
    private val ORDINAL_RE = Regex("^(?:([一二两三四五六七八九])?十)?([一二两三四五六七八九])?$")
    private val INVISIBLE_RE = Regex("[\\u200b-\\u200f\\u202a-\\u202e\\u2060\\ufeff]")
    private val PUNCT_RE = Regex("[\\s·・:：!！?？,，。.'\"“”‘’《》【】\\[\\]（）()_\\-—~△]")
    private val SEASON_CN_RE = Regex("^(.+?)第([一二两三四五六七八九十\\d]{1,3})季$")
    private val SEASON_EN_RE = Regex("^(.+?)season(\\d{1,2})$")
    private val SEASON_NUM_RE = Regex("^(.*\\D)(\\d{1,2})$")
    private val EP_RANGE_RE = Regex("^(.+?)\\s*第?\\s*(\\d{1,4})\\s*[-—~至]\\s*(\\d{1,4})\\s*[集话]$")
    private val NOT_FEATURE_RE = Regex("预告|解说|花絮|幕后|速看|精彩片段")
    private val REGION_NOTE_RE = Regex("\\s*[（(][^（()）]{1,8}[)）]$")
    private val SEARCH_SEASON_RE = Regex("\\s*(?:第[一二两三四五六七八九十\\d]{1,3}季|season\\s*\\d{1,2}|(?<=\\D)\\d{1,2})$", RegexOption.IGNORE_CASE)
    private val SEARCH_CHUNK_RE = Regex("[\\s·・:：!！?？,，。.'\"“”‘’《》【】\\[\\]（）()_\\-—~△]+")
    private val CJK_CHAR_RE = Regex("[\\u3400-\\u9fff]")
    private val EP_TRAILER_RE = Regex("预告|花絮|特辑|解说|彩蛋|幕后|速看|精彩片段")
    private val EP_NUM_CN_RE = Regex("^(?:第)?0*(\\d+)(?:集|期|话|回)?(?:已?完结|大结局|完)?$")
    private val EP_NUM_EN_RE = Regex("^(?:EP|E)0*(\\d+)$", RegexOption.IGNORE_CASE)
    private val COUNTER_RE = Regex("^(?:第)?\\d{1,4}(?:集|期|话|回)?$|^(?:EP|E)\\d+$", RegexOption.IGNORE_CASE)
    private val ISSUE_BARE_RE = Regex("[\\s()（）\\[\\]【】\\-_.·:：]")
    private val ISSUE_DATE_RE = Regex("(?:^|\\D)(20\\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\\d|3[01]))(?!\\d)")
    private val ISSUE_PREFIX_RE = Regex("^第?期")
    private val VARIANT_RES_RE = Regex("RESOLUTION=(\\d+)x(\\d+)")
    private val VARIANT_BW_RE = Regex("(?:^|[,:])BANDWIDTH=(\\d+)")
    private val COUNTRY_NAMES = Taxonomy.REGIONS.getValue(MediaType.TV).filter { it !in Taxonomy.REGION_GROUPS }.toSet()
    private val COUNTRY_ALIASES = mapOf("大陆" to "中国大陆", "内地" to "中国大陆", "中国" to "中国大陆", "香港" to "中国香港", "台湾" to "中国台湾")

    private fun countries(raw: String?): List<String> = nfkc(raw.orEmpty()).split(Regex("[\\s/,，、;；|]+"))
        .map { COUNTRY_ALIASES[it] ?: it }.filter { it in COUNTRY_NAMES }

    private fun nfkc(raw: String): String = Normalizer.normalize(raw, Normalizer.Form.NFKC)

    fun ordinal(raw: String): Int? {
        if (Regex("^\\d{1,3}$").matches(raw)) return raw.toIntOrNull()
        if (raw.isEmpty()) return null
        val m = ORDINAL_RE.matchEntire(raw) ?: return null
        val tens = if ('十' in raw) (m.groupValues[1].firstOrNull()?.let { CJK_DIGIT[it] } ?: 1) * 10 else 0
        val ones = m.groupValues[2].firstOrNull()?.let { CJK_DIGIT[it] } ?: 0
        val total = tens + ones
        return if (total > 0) total else null
    }

    fun squash(raw: String): String =
        PUNCT_RE.replace(INVISIBLE_RE.replace(nfkc(raw).lowercase(Locale.US), ""), "")

    fun normalizedTitle(raw: String): String =
        LANGUAGE_RE.replace(squash(raw), "")

    fun titleKey(raw: String): TitleKey {
        val flat = squash(raw)
        val plain = LANGUAGE_RE.replace(flat, "")
        val season = SEASON_CN_RE.matchEntire(plain)
            ?: SEASON_EN_RE.matchEntire(plain)
            ?: SEASON_NUM_RE.matchEntire(plain)
        val num = season?.let { ordinal(it.groupValues[2]) }
        return if (season != null && num != null) {
            TitleKey(season.groupValues[1], num, plain != flat)
        } else {
            TitleKey(plain, 1, plain != flat)
        }
    }

    fun classifySourceType(raw: String): MediaType? = when {
        Regex("动漫|动画").containsMatchIn(raw) -> MediaType.ANIME
        Regex("纪录|记录").containsMatchIn(raw) -> MediaType.DOC
        Regex("综艺|晚会|脱口秀|真人秀").containsMatchIn(raw) -> MediaType.VARIETY
        Regex("片$|电影").containsMatchIn(raw) -> MediaType.MOVIE
        Regex("剧$|剧集|电视|连续剧|短剧").containsMatchIn(raw) -> MediaType.TV
        else -> null
    }

    fun episodeRange(alias: String): EpisodeRange? {
        val m = EP_RANGE_RE.matchEntire(nfkc(alias).trim()) ?: return null
        val name = m.groupValues[1].trim()
        if (name == "第") return null
        val first = m.groupValues[2].toIntOrNull() ?: return null
        val last = m.groupValues[3].toIntOrNull() ?: return null
        return if (first >= 1 && last >= first) EpisodeRange(name, first, last) else null
    }

    fun runOf(line: Line, range: EpisodeRange): Line? {
        val numbered = line.episodes.filter { it.number != null && it.number >= 1 }
        if (numbered.isEmpty() || numbered.size < line.episodes.size * 0.9) return null
        val maxNum = numbered.maxOf { it.number!! }
        if (maxNum > line.episodes.size * 3 + 10) return null
        val times = HashMap<Int, Int>()
        for (ep in numbered) {
            val n = ep.number!!
            times[n] = (times[n] ?: 0) + 1
        }
        val episodes = numbered
            .filter { times[it.number!!] == 1 && it.number in range.first..range.last }
            .map { it.copy(number = it.number!! - range.first + 1) }
        return if (episodes.isNotEmpty()) Line(line.name, episodes) else null
    }

    fun matchRecord(item: MediaItem, raw: RawVod, hints: WorkHints = WorkHints()): RecordMatch? {
        val vodName = raw.vodName?.takeIf { it.isNotEmpty() } ?: return null
        val typeName = raw.typeName ?: ""
        if (NOT_FEATURE_RE.containsMatchIn(vodName) || NOT_FEATURE_RE.containsMatchIn(typeName) || Adult.shelf(typeName)) return null
        val year = Regex("^\\d+").find(raw.vodYear?.trim() ?: "")?.value?.toIntOrNull()
        val type = classifySourceType(typeName)
        val wantedCountries = countries(item.region)
        val sourceCountries = countries(raw.vodArea)
        if (wantedCountries.isNotEmpty() && sourceCountries.isNotEmpty() && wantedCountries.none { it in sourceCountries }) return null
        val plain = LANGUAGE_RE.replace(squash(vodName), "")
        val candidates = ArrayList<String>(2).apply {
            add(vodName)
            if (year != null && year > 1800 && plain.endsWith(year.toString())) {
                add(plain.substring(0, plain.length - 4))
            }
        }
        val keys = candidates.map { titleKey(it) }.filter { it.base.isNotEmpty() }
        fun named(title: String): Boolean {
            val wanted = titleKey(title)
            return keys.any { it.base == wanted.base && it.season == wanted.season }
        }
        val aliases = hints.aliases ?: emptyList()

        val range = aliases.mapNotNull { episodeRange(it) }.firstOrNull { named(it.name) }
        val rangeYearInvalid = item.year != null && year != null && range != null &&
            (if (range.first == 1) year != item.year else year > item.year)
        if (range != null && type == item.type && !rangeYearInvalid) {
            val byTotal = hints.totalEpisodes?.let { range.first + it - 1 } ?: 0
            val last = max(range.last, byTotal)
            return RecordMatch(range = range.copy(last = last))
        }

        if (named(item.title)) {
            if (item.year != null && year != null && item.year != year) {
                return if (abs(item.year - year) == 1 && type == item.type) RecordMatch(weak = true) else null
            }
            if (type != null && type != item.type) {
                val sameYear = item.year != null && year != null && item.year == year
                val allowed = when (item.type) {
                    MediaType.DOC -> setOf(MediaType.VARIETY, MediaType.TV, MediaType.MOVIE)
                    MediaType.VARIETY -> setOf(MediaType.DOC)
                    else -> emptySet()
                }
                if (!sameYear || type !in allowed) return null
            }
            if (type == null && year == null) return null
            return RecordMatch()
        }

        val aliasMatch = aliases.any { episodeRange(it) == null && named(REGION_NOTE_RE.replace(it, "")) }
        return if (aliasMatch && item.year != null && item.year == year && type == item.type) {
            RecordMatch(weak = true)
        } else null
    }

    fun searchTerms(title: String): List<String> {
        val whole = INVISIBLE_RE.replace(title, "").trim()
        val seasonless = SEARCH_SEASON_RE.replace(whole, "").trim()
        val chunks = seasonless.split(SEARCH_CHUNK_RE).filter { it.isNotEmpty() }
        val longest = chunks.fold("") { best, chunk -> if (chunk.length > best.length) chunk else best }
        val distinctive = if (CJK_CHAR_RE.containsMatchIn(longest)) longest.length >= 2 else longest.length >= 4
        return buildList {
            if (distinctive) add(longest)
            if (seasonless.isNotEmpty()) add(seasonless)
            if (whole.isNotEmpty()) add(whole)
        }.distinct()
    }

    fun workTerms(title: String, aliases: List<String> = emptyList()): List<String> {
        val serials = aliases.mapNotNull { episodeRange(it)?.name }
        val others = aliases
            .filter { episodeRange(it) == null && CJK_CHAR_RE.containsMatchIn(it) }
            .map { REGION_NOTE_RE.replace(it, "") }
            .take(2)
        return (searchTerms(title) + serials.flatMap { searchTerms(it) } + others.mapNotNull { searchTerms(it).firstOrNull() }).distinct()
    }

    private val explicitEpisode = Regex("""(?i)^(?:(?:第)?\d+(?:集|话|回)(?:已?完结|大结局|完)?|(?:EP|E)\d+)$""")

    private fun hasEpisodeNumber(episode: Episode, entries: Int): Boolean {
        val n = episode.number ?: return false
        return n in 1..10000 && (n <= entries * 3 + 10 || explicitEpisode.matches(episode.title))
    }

    fun parseLines(from: String, value: String): List<Line> {
        val names = from.split("$$$")
        val blobs = value.split("$$$")
        val out = ArrayList<Line>()
        for (idx in blobs.indices) {
            val name = names.getOrNull(idx) ?: "线路 ${idx + 1}"
            if (name.contains("yun", ignoreCase = true)) continue
            val episodes = ArrayList<Episode>()
            for (entry in blobs[idx].split('#')) {
                val sep = entry.indexOf('$')
                val title = if (sep >= 0) entry.substring(0, sep).trim() else ""
                val raw = (if (sep >= 0) entry.substring(sep + 1) else entry).trim().replace("&amp;", "&")
                val full = if (raw.startsWith("//")) "https:$raw" else raw
                val uri = try { URI(full) } catch (_: Exception) { continue }
                val scheme = uri.scheme?.lowercase(Locale.US)
                if (scheme != "https" && scheme != "http") continue
                val path = uri.rawPath ?: ""
                val format = when {
                    path.endsWith(".m3u8", ignoreCase = true) -> "hls"
                    path.endsWith(".mp4", ignoreCase = true) -> "mp4"
                    else -> continue
                }
                if (title.isNotEmpty() && EP_TRAILER_RE.containsMatchIn(title)) continue
                val numMatch = EP_NUM_CN_RE.matchEntire(title) ?: EP_NUM_EN_RE.matchEntire(title)
                val number = numMatch?.groupValues?.get(1)?.toIntOrNull()
                episodes.add(Episode(title, uri.toString(), format, number))
            }
            if (episodes.isEmpty()) continue
            val numbered = episodes.all { hasEpisodeNumber(it, episodes.size) }
            if (!numbered) {
                out.add(Line(name, episodes))
                continue
            }
            val mirrors = ArrayList<LinkedHashMap<Int, Episode>>()
            val seen = HashSet<String>()
            for (episode in episodes) {
                if (!seen.add("${episode.number}:${episode.url}")) continue
                val mirror = mirrors.firstOrNull { !it.containsKey(episode.number!!) }
                if (mirror != null) mirror[episode.number!!] = episode else mirrors.add(linkedMapOf(episode.number!! to episode))
            }
            out.addAll(mirrors.map { Line(name, it.values.toList()) })
        }
        return out
    }

    fun numbering(line: Line): Numbering {
        val numbers = line.episodes.map { it.number }
        val nonNull = numbers.filterNotNull()
        val numeric = numbers.isNotEmpty() &&
            nonNull.size == numbers.size &&
            line.episodes.all { hasEpisodeNumber(it, numbers.size) } &&
            nonNull.toHashSet().size == numbers.size
        val byNumber = LinkedHashMap<Int, Episode>(line.episodes.size)
        for (i in line.episodes.indices) {
            val ep = line.episodes[i]
            val key = if (numeric) ep.number!! else i + 1
            byNumber[key] = ep
        }
        val titles = line.episodes.map { it.title }
        val titled = !numeric &&
            titles.toHashSet().size == titles.size &&
            titles.all { it.isNotEmpty() && !COUNTER_RE.matches(it) }
        val count = byNumber.keys.maxOrNull() ?: 0
        return Numbering(byNumber, numeric, titled, count)
    }

    fun issueKey(title: String): Issue {
        val bare = ISSUE_BARE_RE.replace(title, "")
        val date = ISSUE_DATE_RE.find(bare)?.groupValues?.get(1)
        return if (date != null) {
            Issue(date, ISSUE_PREFIX_RE.replace(bare.replace(date, ""), ""))
        } else {
            Issue(null, bare)
        }
    }

    fun sameIssue(wanted: Episode, reference: Line, other: Line): Episode? {
        val index = reference.episodes.indexOfFirst { it === wanted || it == wanted }
        if (index < 0) return null
        val mine = reference.episodes.map { issueKey(it.title) }
        val theirs = other.episodes.map { issueKey(it.title) }
        val key = mine[index]

        fun once(list: List<Issue>, test: (Issue) -> Boolean): Int? {
            var hit: Int? = null
            for (i in list.indices) {
                if (test(list[i])) {
                    if (hit != null) return null
                    hit = i
                }
            }
            return hit
        }

        fun pair(test: (Issue) -> Boolean): Int? =
            if (once(mine, test) == index) once(theirs, test) else null

        val named = key.rest.length >= 2
        var hit: Int? = null
        if (key.date != null || named) {
            hit = pair { it.date == key.date && it.rest == key.rest }
        }
        if (hit == null && key.date != null) {
            val candidate = pair { it.date == key.date }
            if (candidate != null && (theirs[candidate].rest.contains(key.rest) || key.rest.contains(theirs[candidate].rest))) {
                hit = candidate
            }
        }
        if (hit == null && named) {
            val candidate = pair { it.rest == key.rest }
            if (candidate != null && !(theirs[candidate].date != null && key.date != null)) {
                hit = candidate
            }
        }
        return hit?.let { other.episodes[it] }
    }

    fun manifestVariants(text: String, baseUrl: String): List<ManifestVariant> {
        val lines = text.split(Regex("\\r?\\n")).map { it.trim() }
        val out = ArrayList<ManifestVariant>()
        for (i in 0 until lines.size - 1) {
            val line = lines[i]
            val next = lines[i + 1]
            if (!line.startsWith("#EXT-X-STREAM-INF:") || next.isEmpty() || next.startsWith("#")) continue
            val resolved = try {
                PublicNetwork.resolveUrl(baseUrl, next)
            } catch (_: Exception) {
                continue
            }
            val scheme = try {
                URI(resolved).scheme?.lowercase(Locale.US)
            } catch (_: Exception) {
                null
            }
            if (scheme != "http" && scheme != "https") continue
            val size = VARIANT_RES_RE.find(line)
            val quality = size?.let {
                val w = it.groupValues[1].toIntOrNull() ?: 0
                val h = it.groupValues[2].toIntOrNull() ?: 0
                Quality.forPicture(w, h)
            }
            val bw = VARIANT_BW_RE.find(line)?.groupValues?.get(1)?.toIntOrNull() ?: 0
            out.add(ManifestVariant(resolved, quality, bw))
        }
        return out
    }

    fun referenceLine(lines: List<Line>): Line? {
        val reliable = lines.filter { val n = numbering(it); n.numeric || n.titled }
        val pool = if (reliable.isNotEmpty()) reliable else lines
        var best: Line? = null
        var bestCount = -1
        for (line in pool) {
            val c = numbering(line).count
            if (best == null || c > bestCount) {
                best = line
                bestCount = c
            }
        }
        return best
    }

    fun rank(found: List<Candidate>): List<Candidate> {
        val run = found.mapNotNull { it.run }.maxOrNull() ?: 0
        val aligned = if (run <= 0) {
            found
        } else {
            found.mapNotNull { c ->
                if (c.run != null) c
                else {
                    val cut = c.lines.mapNotNull { runOf(it, EpisodeRange("", 1, run)) }
                    if (cut.isNotEmpty()) c.copy(lines = cut) else null
                }
            }
        }
        val pool = if (aligned.any { !it.weak }) aligned.filter { !it.weak } else aligned
        return pool.sortedWith(compareBy<Candidate> { it.dubbed }.thenByDescending { it.source.priority })
    }
}

fun interface CatalogueFetcher {
    suspend fun getJson(url: String, timeoutMs: Int): String
}

class PlaybackService(
    private val rules: SourceRules,
    private val warmCache: WarmMediaCache,
    private val catalogueFetcher: CatalogueFetcher? = null,
    private val searchGraceMs: Long = 1_200L,
    private val requeryDelayMs: Long = 1_000L,
    private val firstSegmentGraceMs: Long = 3_000L,
    private val betterPictureMs: Long = 1_500L,
    private val turnMs: Long = 2_500L,
    private val mediaFetcher: MediaFetcher? = null,
    private val health: SourceHealthStore? = null,
    private val alignment: AlignmentConfig? = null,
    private val catalogueTimeoutMs: Int = 9000,
    private val catalogueClock: () -> Long = System::currentTimeMillis,
    private val onFailureLog: (String, String, Long) -> Unit = { _, _, _ -> },
) {
    private data class CachedCandidates(val value: List<Candidate>, val expires: Long)
    private data class CachedPlayback(val value: CompletableDeferred<Playback>, val expires: Long)
    private data class SelectionIntent(val intent: Long, val key: String)
    private data class FailureState(val count: Int, val until: Long, val since: Long)
    private data class Attempt(val source: PlaySource, val line: Line, val target: Episode)
    private class AlignmentMismatch : IllegalStateException(Copy.Extra.LINE_SWITCH_FAILED)
    private class Reached(
        val playback: Playback,
        val whole: CompletableDeferred<Unit>,
        val shown: Quality?,
        val margin: () -> Double? = { null },
        val received: () -> Long,
    )

    private val lock = Any()
    private val cache = LinkedHashMap<String, CachedCandidates>(32, 0.75f, true)
    private class CatalogueLookup {
        val first = CompletableDeferred<List<Candidate>>()
        val complete = CompletableDeferred<List<Candidate>>()
    }

    private val inflight = HashMap<String, CatalogueLookup>()
    private val resolved = LinkedHashMap<String, CachedPlayback>(32, 0.75f, true)
    private val failures = HashMap<String, FailureState>()
    private val selected = LinkedHashMap<String, String>(64, 0.75f, true)
    private val preferred = LinkedHashMap<String, String>(64, 0.75f, true)
    private val preferenceRevisions = LinkedHashMap<String, Long>(64, 0.75f, true)
    private val manualIntents = HashMap<String, Long>()
    private val selectionIntents = LinkedHashMap<String, SelectionIntent>(64, 0.75f, true)
    private var revisionClock = 0L
    private val winners = LinkedHashMap<String, String>(64, 0.75f, true)
    private val episodeCatalogues = LinkedHashMap<String, Availability>(128, 0.75f, true)
    private val behind = HashMap<String, Long>()
    // The bundled pool has nine enabled catalogues. Leave capacity above that so a hung
    // high-priority directory cannot keep the last fallback from starting its search.
    private val searchLimiter = Semaphore(12)
    private val probeScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val searchScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    fun knownAvailability(itemId: String): Availability? = synchronized(lock) { episodeCatalogues[itemId] }

    private fun workKey(item: MediaItem, hints: WorkHints): String = listOf(
        item.id, item.title, item.year?.toString().orEmpty(), item.type.wire, item.region.orEmpty(),
        hints.single?.toString().orEmpty(), hints.totalEpisodes?.toString().orEmpty(),
        *(hints.aliases?.toTypedArray() ?: emptyArray()),
    ).joinToString("|")

    private fun forgetPreparedLocked(work: String) {
        val iterator = resolved.keys.iterator()
        while (iterator.hasNext()) if (iterator.next().startsWith("$work|")) iterator.remove()
    }

    private fun trimRevisionsLocked() {
        while (preferenceRevisions.size > 512) {
            val old = preferenceRevisions.keys.first()
            preferenceRevisions.remove(old)
            manualIntents.remove(old)
            forgetPreparedLocked(old)
        }
    }

    private fun revisionLocked(work: String): Long {
        val value = preferenceRevisions[work] ?: ++revisionClock
        preferenceRevisions[work] = value
        trimRevisionsLocked()
        return value
    }

    private fun preferLocked(work: String, source: String) {
        if (!preferred.containsKey(work) && preferred.size >= 256) {
            val old = preferred.keys.first()
            preferred.remove(old)
            preferenceRevisions[old] = ++revisionClock
            forgetPreparedLocked(old)
        }
        preferred[work] = source
        preferenceRevisions[work] = ++revisionClock
        trimRevisionsLocked()
        forgetPreparedLocked(work)
        val iterator = selected.keys.iterator()
        while (iterator.hasNext()) if (iterator.next().startsWith("$work:")) iterator.remove()
    }

    suspend fun prepareItem(item: MediaItem, episode: Int, hints: WorkHints = WorkHints(), resume: Boolean = false): MediaItem {
        require(episode in 1..10000) { Copy.Extra.INVALID_INPUT }
        var prepared = availability(item, hints).applyTo(item)
        if (Rules.episodeToPlay(prepared, episode) != episode) prepared = availability(item, hints, complete = true).applyTo(item)
        // Catalogue presence for the work is insufficient when this episode is
        // missing, especially for series that are still being released.
        attempts(prepared, if (resume) Rules.episodeToPlay(prepared, episode) else episode, hints)
        return prepared
    }

    suspend fun availability(item: MediaItem, hints: WorkHints = WorkHints(), complete: Boolean = false): Availability {
        val single = hints.single ?: (item.type == MediaType.MOVIE)
        val candidates = candidates(item, hints, complete)
        val line = PlaybackMatchers.referenceLine(candidates.flatMap { it.lines })
            ?: throw IllegalStateException(Copy.Extra.SOURCE_UNAVAILABLE)
        val plan = PlaybackMatchers.numbering(line)
        val result = if (single || plan.count <= 1) Availability()
        else if (plan.numeric) {
            val numbers = candidates.flatMap { it.lines }.map(PlaybackMatchers::numbering)
                .filter { it.numeric }.flatMap { it.byNumber.keys }.toSortedSet()
            Availability(episodes = plan.count, episodeNumbers = numbers.takeIf { it.size < plan.count }?.toList())
        } else {
            Availability(episodes = plan.count, episodeTitles = if (plan.titled) line.episodes.map { it.title } else null)
        }
        synchronized(lock) {
            if (episodeCatalogues.size >= 512 && !episodeCatalogues.containsKey(item.id)) {
                episodeCatalogues.keys.firstOrNull()?.let { episodeCatalogues.remove(it) }
            }
            episodeCatalogues[item.id] = result
        }
        return result
    }

    suspend fun resolve(
        item: MediaItem,
        episode: Int,
        quality: Quality? = null,
        retry: Boolean = false,
        hints: WorkHints = WorkHints(),
        from: String? = null,
        retryFailureKind: FailureKind? = null,
        switchingFrom: Playback? = null,
        userRetry: Boolean = false,
    ): Playback {
        require(episode in 1..10000) { "集数无效" }
        val (revision, intent) = synchronized(lock) {
            revisionLocked(item.id) to if (from != null) (++revisionClock).also { manualIntents[item.id] = it } else null
        }
        val key = "${workKey(item, hints)}|$episode|${quality?.label ?: ""}|$revision"
        val selectionKey = "${item.id}:$episode"
        var selectionIntent = 0L
        val deferred = CompletableDeferred<Playback>()
        val known = synchronized(lock) {
            val cached = resolved[key]
            if (switchingFrom == null && !retry && !userRetry && from == null && cached != null && cached.expires > System.currentTimeMillis() && selectionIntents[selectionKey]?.key == key) {
                cached.value
            } else {
                selectionIntent = ++revisionClock
                selectionIntents[selectionKey] = SelectionIntent(selectionIntent, key)
                while (selectionIntents.size > 512) selectionIntents.remove(selectionIntents.keys.first())
                resolved.remove(key)
                while (resolved.size >= 64) {
                    val oldest = resolved.keys.firstOrNull() ?: break
                    resolved.remove(oldest)
                }
                resolved[key] = CachedPlayback(deferred, System.currentTimeMillis() + RESOLVED_MS)
                null
            }
        }
        if (known != null) {
            try {
                val cached = known.await()
                if (cached.sourceKey?.let { health?.rankFor(it, item.id)?.cooled } != true) return cached
                synchronized(lock) { if (resolved[key]?.value === known) resolved.remove(key) }
                return resolve(item, episode, quality, retry, hints, from, retryFailureKind, switchingFrom, userRetry)
            } catch (cancelled: CancellationException) {
                // The preload's owner may have gone away while this screen is
                // still awaiting its result. Only the current caller's own
                // cancellation is terminal; otherwise create/join a fresh task.
                currentCoroutineContext().ensureActive()
                synchronized(lock) { if (resolved[key]?.value === known) resolved.remove(key) }
                return resolve(item, episode, quality, retry, hints, from, retryFailureKind, switchingFrom, userRetry)
            }
        }
        return try {
            val result = choose(item, episode, quality, retry, hints, from, revision, selectionIntent, intent, retryFailureKind, switchingFrom, userRetry)
            deferred.complete(result)
            if (from != null) synchronized(lock) {
                if (selectionIntents[selectionKey]?.intent == selectionIntent && manualIntents[item.id] == intent && preferred[item.id] == from) {
                    val current = "${workKey(item, hints)}|$episode|${quality?.label ?: ""}|${revisionLocked(item.id)}"
                    if (resolved.size >= 64 && !resolved.containsKey(current)) resolved.keys.firstOrNull()?.let { resolved.remove(it) }
                    resolved[current] = CachedPlayback(deferred, System.currentTimeMillis() + RESOLVED_MS)
                    selectionIntents[selectionKey] = SelectionIntent(selectionIntent, current)
                }
            }
            result
        } catch (t: Throwable) {
            synchronized(lock) {
                if (resolved[key]?.value === deferred) resolved.remove(key)
            }
            deferred.completeExceptionally(t)
            throw t
        }
    }

    suspend fun sources(item: MediaItem, episode: Int, hints: WorkHints = WorkHints(), complete: Boolean = false): PlaySources {
        val attempts = attempts(item, episode, hints, complete)
        val seen = LinkedHashMap<String, SourceOption>()
        for (a in attempts) {
            if (!seen.containsKey(a.source.key)) {
                seen[a.source.key] = SourceOption(a.source.key, a.source.name)
            }
        }
        val list = seen.values.toList()
        val current = synchronized(lock) { selected["${item.id}:$episode"] }
        return PlaySources(list, current?.takeIf { cur -> list.any { it.key == cur } })
    }

    private suspend fun attempts(item: MediaItem, episode: Int, hints: WorkHints, complete: Boolean = false): List<Attempt> {
        val single = hints.single ?: (item.type == MediaType.MOVIE)
        val candidates = candidates(item, hints, complete)
        val primary = PlaybackMatchers.referenceLine(candidates.flatMap { it.lines })
        val plan = primary?.let { PlaybackMatchers.numbering(it) }
        val wanted = plan?.byNumber?.get(episode)
        val out = ArrayList<Attempt>()
        for (c in candidates) {
            for (line in c.lines) {
                val other = PlaybackMatchers.numbering(line)
                val target = when {
                    single -> if (episode == 1) line.episodes.firstOrNull() else null
                    plan?.numeric == true -> if (other.numeric) other.byNumber[episode] else null
                    line === primary -> wanted
                    other.numeric || wanted == null || wanted.title.isEmpty() -> null
                    other.byNumber[episode]?.title == wanted.title -> other.byNumber[episode]
                    else -> PlaybackMatchers.sameIssue(wanted, primary!!, line)
                }
                if (target != null) out.add(Attempt(c.source, line, target))
            }
        }
        if (out.isEmpty() && !complete) return attempts(item, episode, hints, complete = true)
        if (out.isEmpty()) throw IllegalStateException(Copy.Extra.NO_EPISODE)
        return out
    }

    private suspend fun choose(
        item: MediaItem,
        episode: Int,
        quality: Quality?,
        retry: Boolean,
        hints: WorkHints,
        from: String?,
        revision: Long,
        selectionIntent: Long,
        intent: Long?,
        retryFailureKind: FailureKind?,
        switchingFrom: Playback?,
        userRetry: Boolean,
    ): Playback {
        val selectionKey = "${item.id}:$episode"
        val previous = synchronized(lock) { selected[selectionKey] }
        if (retry && previous != null) {
            setBack(item.id, previous)
            if (retryFailureKind != null) health?.recordFailure(previous, retryFailureKind, item.id, episode)
        }
        val now = System.currentTimeMillis()
        val rawAttempts = attempts(item, episode, hints, complete = from != null)
        val winner = synchronized(lock) { winners[item.id] }
        val ranks = rawAttempts.associateWith {
            health?.rankFor(it.source.key, item.id, now) ?: HealthVerdict(false, 0.5)
        }
        val sorted = rawAttempts.filter { it.source.key == from || !ranks.getValue(it).cooled }.sortedWith(Comparator { a, b ->
            fun score(attempt: Attempt) = SourceOrderScore(
                behind = synchronized(lock) { (behind[behindKey(item.id, attempt.source.key)] ?: 0L) > now } ||
                    ranks[attempt]?.cooled == true,
                previous = attempt.source.key == previous,
                winner = attempt.source.key == winner,
            )
            val order = DeliverySpeed.compareSourceOrder(score(a), score(b), retry)
            if (order != 0) order else HealthRules.compareRank(ranks.getValue(a), ranks.getValue(b))
        })
        val alternatives = if (retry && previous != null && from == null) sorted.filter { it.source.key != previous } else emptyList()
        val ordered = alternatives.ifEmpty { sorted }
        val lastChance = if (alternatives.isNotEmpty()) sorted.filter { it.source.key == previous } else emptyList()

        val asked = from ?: if (retry) null else synchronized(lock) { preferred[item.id] }
        val own = if (asked != null) sorted.filter { it.source.key == asked } else emptyList()
        if (from != null && own.isEmpty()) throw IllegalStateException(Copy.Extra.NO_EPISODE)
        val rest = if (from != null) emptyList() else ordered.filter { a -> own.none { it === a } }

        val failed = HashMap<Attempt, Throwable>()
        val enough = minOf((quality ?: Quality.Q1080P).rank, Quality.Q1080P.rank).toDouble()
        fun worth(shown: Quality?): Double = if (shown != null) minOf(shown.rank.toDouble(), enough) else 1.5

        suspend fun contest(list: List<Attempt>): Playback = coroutineScope {
            val winner = CompletableDeferred<Playback>()
            val cLock = Any()
            class LiveEntry(val attempt: Attempt, val started: Long, val cancellation: MediaRequestCancellation = MediaRequestCancellation(), @Volatile var reached: Reached? = null)
            val live = ArrayList<LiveEntry>()
            val held = ArrayList<Triple<Attempt, Playback, DeliveryScore>>()
            var nextIdx = 0
            var over = false
            var settling = false
            var waiting = false
            var extended = false
            val jobs = ArrayList<kotlinx.coroutines.Job>()
            val startedAt = HashMap<Attempt, Long>()

            fun track(job: kotlinx.coroutines.Job) {
                synchronized(cLock) { if (over) job.cancel() else jobs.add(job) }
            }

            fun stop(keep: Attempt?) {
                over = true
                for (entry in live) {
                    if (entry.attempt === keep) continue
                    if (keep != null && System.currentTimeMillis() - entry.started >= turnMs) {
                        setBack(item.id, entry.attempt.source.key)
                    }
                    entry.cancellation.cancel()
                }
                for (j in jobs) j.cancel()
            }

            fun win(attempt: Attempt, playback: Playback) {
                synchronized(cLock) {
                    if (over) return
                    stop(attempt)
                }
                synchronized(lock) {
                    val current = selectionIntents[selectionKey]?.intent == selectionIntent &&
                        (if (from != null) manualIntents[item.id] == intent else preferenceRevisions[item.id] == revision)
                    if (current) {
                        if (from != null) preferLocked(item.id, from)
                        if (selected.size > 512) selected.keys.firstOrNull()?.let { selected.remove(it) }
                        selected[selectionKey] = attempt.source.key
                        if (winners.size > 256) winners.keys.firstOrNull()?.let { winners.remove(it) }
                        winners[item.id] = attempt.source.key
                        val finished = System.currentTimeMillis()
                        val started = startedAt[attempt] ?: finished
                        health?.recordSuccess(attempt.source.key, item.id, episode, finished,
                            startupSec = (finished - started).coerceAtLeast(0L) / 1000.0, quality = playback.quality)
                    }
                }
                winner.complete(playback)
            }

            fun settleNow() {
                val best = synchronized(cLock) {
                    if (over || held.isEmpty()) return
                    held.reduce { a, b -> if (DeliverySpeed.compare(b.third, a.third) > 0) b else a }
                }
                win(best.first, best.second)
            }

            fun scheduleSettle(delayMs: Long) {
                val j = launch {
                    delay(delayMs)
                    val shouldExtend = synchronized(cLock) {
                        if (over) return@launch
                        val poor = held.all { it.third.picture < Quality.Q720P.rank.toDouble() }
                        if (poor && !extended && live.any { it.reached != null }) {
                            extended = true
                            true
                        } else false
                    }
                    if (shouldExtend) {
                        delay(betterPictureMs)
                        settleNow()
                    } else {
                        settleNow()
                    }
                }
                track(j)
            }

            lateinit var startMore: () -> Unit
            lateinit var runPatient: () -> Unit

            runPatient = {
                val j = launch {
                    while (true) {
                        val waitMs = synchronized(cLock) {
                            waiting = false
                            if (over || live.isEmpty()) return@launch
                            if (held.isNotEmpty()) return@launch
                            val lastStarted = live.maxOf { it.started }
                            lastStarted + firstSegmentGraceMs - System.currentTimeMillis()
                        }
                        if (waitMs > 0L) {
                            delay(waitMs)
                            continue
                        }
                        val picked = synchronized(cLock) {
                            if (over || live.isEmpty() || held.isNotEmpty()) return@launch
                            val answered = live.filter { it.reached != null }
                            if (answered.isEmpty()) null
                            else {
                                val nowMs = System.currentTimeMillis()
                                answered.reduce { a, b ->
                                    fun score(e: LiveEntry) = DeliveryScore(worth(e.reached!!.shown), e.reached!!.margin())
                                    val compared = DeliverySpeed.compare(score(b), score(a))
                                    fun rate(e: LiveEntry) = e.reached!!.received().toDouble() / max(1L, nowMs - e.started)
                                    if (compared > 0 || (compared == 0 && rate(b) > rate(a))) b else a
                                }
                            }
                        }
                        if (picked == null) {
                            delay(100L)
                            continue
                        }
                        picked.reached!!.margin()?.takeIf { it < DeliverySpeed.PLAYBACK_HEADROOM }?.let { setBack(item.id, picked.attempt.source.key) }
                        win(picked.attempt, picked.reached!!.playback)
                        return@launch
                    }
                }
                track(j)
            }

            fun onDelivered(entry: LiveEntry, reached: Reached) {
                if (synchronized(cLock) { over }) return
                val margin = reached.margin()
                if (margin != null && margin < DeliverySpeed.PLAYBACK_HEADROOM) setBack(item.id, entry.attempt.source.key)
                else synchronized(lock) { behind.remove(behindKey(item.id, entry.attempt.source.key)) }
                val value = worth(reached.shown)
                if (value >= enough && margin != null && margin >= DeliverySpeed.PLAYBACK_HEADROOM) {
                    win(entry.attempt, reached.playback)
                    return
                }
                var triggerSettle = false
                synchronized(cLock) {
                    if (over) return
                    live.remove(entry)
                    held.add(Triple(entry.attempt, reached.playback, DeliveryScore(value, margin)))
                    if (!settling) {
                        settling = true
                        triggerSettle = true
                    }
                }
                startMore()
                if (synchronized(cLock) { !over && live.isEmpty() }) settleNow()
                else if (triggerSettle) scheduleSettle(betterPictureMs)
            }

            fun onLose(entry: LiveEntry, error: Throwable) {
                var emptyWithHeld = false
                var emptyNoHeld = false
                synchronized(cLock) {
                    live.remove(entry)
                    if (over) return
                    setBack(item.id, entry.attempt.source.key)
                    failed[entry.attempt] = error
                    health?.recordFailure(
                        entry.attempt.source.key,
                        if (error is AlignmentMismatch) FailureKind.ALIGNMENT else if (entry.reached == null) FailureKind.PROBE else FailureKind.FIRST_SEGMENT,
                        item.id,
                        episode,
                    )
                    if (live.isEmpty()) {
                        if (held.isNotEmpty()) emptyWithHeld = true else emptyNoHeld = true
                    }
                }
                startMore()
                val stillEmpty = synchronized(cLock) { !over && live.isEmpty() }
                if (stillEmpty) {
                    if (emptyWithHeld || synchronized(cLock) { held.isNotEmpty() }) settleNow()
                    else if (emptyNoHeld) {
                        synchronized(cLock) { stop(null) }
                        winner.completeExceptionally(IllegalStateException(Copy.Extra.UNAVAILABLE))
                    }
                }
            }

            startMore = {
                val spawned = ArrayList<LiveEntry>()
                var startPatient = false
                synchronized(cLock) {
                    if (over) return@synchronized
                    val nowMs = System.currentTimeMillis()
                    while (nextIdx < list.size &&
                        live.count { nowMs - it.started < turnMs } < 3 &&
                        live.size < LIVE_MAX
                    ) {
                        val attempt = list[nextIdx++]
                        val entry = LiveEntry(attempt, System.currentTimeMillis())
                        startedAt[attempt] = entry.started
                        live.add(entry)
                        spawned.add(entry)
                    }
                    if (!waiting && live.isNotEmpty()) {
                        waiting = true
                        startPatient = true
                    }
                }
                for (entry in spawned) {
                    val turnJob = launch {
                        delay(turnMs + 5L)
                        if (!synchronized(cLock) { over }) startMore()
                    }
                    val probeJob = launch(Dispatchers.IO) {
                        if (synchronized(cLock) { over }) return@launch
                        val reaching = probeScope.async { probe(entry.attempt.target, entry.attempt.source, quality, entry.cancellation) }
                        try {
                            val reached = withTimeout(REACH_MS) { reaching.await() }
                            if (synchronized(cLock) { over }) return@launch
                            val source = entry.attempt.source.key
                            val candidate = reached.playback
                            candidate.duration?.let { health?.observeDuration(item.id, episode, source, it) }
                            val origin = switchingFrom?.sourceKey
                            if (origin != null && origin != source && alignment != null) {
                                val history = health?.durationHistory(item.id, episode, origin, source) ?: DurationHistory(emptyList(), emptyList())
                                val input = DurationInput(switchingFrom.duration, switchingFrom.durationSource ?: "missing",
                                    candidate.duration, candidate.durationSource ?: "missing")
                                if (AlignmentRules.durationVerdict(input, history, alignment).verdict == "suspect") throw AlignmentMismatch()
                            }
                            entry.reached = reached
                            reached.whole.await()
                            onDelivered(entry, reached)
                        } catch (t: Throwable) {
                            if (t is CancellationException && t !is TimeoutCancellationException) throw t
                            entry.cancellation.cancel()
                            val failure = if (t is TimeoutCancellationException) IllegalStateException("片源响应超时", t) else t
                            if (!synchronized(cLock) { over }) {
                                onFailureLog(entry.attempt.source.key, "probe: ${failure.message}", System.currentTimeMillis() - entry.started)
                                onLose(entry, failure)
                            }
                        } finally {
                            if (!reaching.isCompleted) { entry.cancellation.cancel(); reaching.cancel() }
                        }
                    }
                    track(turnJob)
                    track(probeJob)
                }
                if (startPatient) runPatient()
                if (synchronized(cLock) { !over && live.isEmpty() && held.isEmpty() && nextIdx >= list.size }) {
                    winner.completeExceptionally(IllegalStateException(Copy.Extra.UNAVAILABLE))
                }
            }

            try {
                startMore()
                winner.await()
            } finally {
                synchronized(cLock) { if (!over) stop(null) }
            }
        }

        fun eligible(attempt: Attempt) = attempt.source.key == from || health?.rankFor(attempt.source.key, item.id)?.cooled != true
        for (group in listOf(own, rest, lastChance)) {
            val list = group.filter(::eligible)
            if (list.isNotEmpty()) {
                try {
                    return contest(list)
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (_: Throwable) {
                }
            }
        }
        if (userRetry && from == null) {
            val cooled = rawAttempts.filter { it !in failed && ranks.getValue(it).cooled }
            if (cooled.isNotEmpty()) {
                try { return contest(cooled) }
                catch (cancelled: CancellationException) { throw cancelled }
                catch (_: Exception) { }
            }
        }
        val allAttempts = attempts(item, episode, hints, complete = true)
        val late = allAttempts.filter { it !in rawAttempts && (from == null || it.source.key == from) && (userRetry || eligible(it)) }
        if (late.isNotEmpty()) {
            try { return contest(late) }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { }
        }
        // A confirmed in-player failure on the only catalogue line can be transient. Reconnect
        // that active work once under the player's switch budget, without bypassing cooldown for other works.
        if (retryFailureKind != null && previous != null && allAttempts.all { it.source.key == previous }) {
            val remaining = allAttempts.filter { it !in failed }
            if (remaining.isNotEmpty()) return contest(remaining)
        }
        val again = (own + rest).filter { attempt ->
            val msg = failed[attempt]?.message ?: ""
            eligible(attempt) && TRANSIENT_RE.containsMatchIn(msg)
        }.take(3)
        if (again.isNotEmpty()) {
            try {
                return contest(again)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Throwable) {
            }
        }
        throw IllegalStateException(Copy.Extra.UNAVAILABLE)
    }

    private fun setBack(itemId: String, sourceKey: String) {
        synchronized(lock) {
            val now = System.currentTimeMillis()
            if (behind.size >= 1024) {
                behind.entries.removeAll { it.value <= now }
                if (behind.size >= 1024) behind.keys.firstOrNull()?.let { behind.remove(it) }
            }
            behind[behindKey(itemId, sourceKey)] = now + SET_BACK_MS
        }
    }

    private fun behindKey(itemId: String, sourceKey: String): String = "$itemId:$sourceKey"

    private suspend fun probe(
        episode: Episode,
        source: PlaySource,
        quality: Quality?,
        cancellation: MediaRequestCancellation,
    ): Reached = withTimeout(REACH_MS) {
        if (cancellation.cancelled) throw CancellationException("请求已取消")
        if (episode.format == "mp4") {
            val resp = mediaFetcher?.open(episode.url, mapOf("Range" to "bytes=0-16383")) ?: withContext(Dispatchers.IO) {
                PublicNetwork.openPublic(
                    episode.url,
                    headers = mapOf("Range" to "bytes=0-16383"),
                    connectTimeoutMs = 8000,
                    readTimeoutMs = 9000,
                    onConnection = cancellation::trackConnection,
                )
            }
            cancellation.trackResponse(resp)
            val head = try {
                if (resp.statusCode !in listOf(200, 206) ||
                    Regex("text/html|application/(?:json|xml)|\\+(?:json|xml)(?:[;\\s]|$)", RegexOption.IGNORE_CASE).containsMatchIn(resp.contentType)
                ) throw IllegalStateException("媒体不可用")
                withContext(Dispatchers.IO) {
                    val prefix = java.io.ByteArrayOutputStream()
                    val buffer = ByteArray(4096)
                    while (prefix.size() < 16384) {
                        currentCoroutineContext().ensureActive()
                        if (cancellation.cancelled) throw CancellationException("请求已取消")
                        val count = resp.stream.read(buffer, 0, minOf(buffer.size, 16384 - prefix.size()))
                        if (count < 0) break
                        prefix.write(buffer, 0, count)
                        if (MediaHead.isMp4Head(prefix.toByteArray())) break
                    }
                    prefix.toByteArray()
                }.also { if (!MediaHead.isMp4Head(it)) throw IllegalStateException("媒体不可用") }
            } finally { resp.close() }
            warmCache.registerSource(episode.url, source, false)
            val duration = DurationReader.mp4(head)
            val chapters = ChapterReader.mp4 { offset, count ->
                if (offset >= head.size) ByteArray(0)
                else head.copyOfRange(offset.toInt(), minOf(head.size, offset.toInt() + count))
            }
            return@withTimeout Reached(
                Playback(url = episode.url, format = "mp4", sourceKey = source.key, duration = duration.seconds,
                    durationSource = duration.source, intro = chapters.intro, outro = chapters.outro),
                CompletableDeferred(Unit),
                shown = null,
                received = { head.size.toLong() },
            )
        }

        var current = episode.url
        var selectedQuality: Quality? = null
        var qualities: List<Quality>? = null
        var preserveTimeline = false

        for (depth in 0 until 4) {
            if (cancellation.cancelled) throw CancellationException("请求已取消")
            val (text, finalUrl) = mediaFetcher?.text(current) ?: withContext(Dispatchers.IO) {
                PublicNetwork.getText(current, connectTimeoutMs = 8000, readTimeoutMs = 9000, onConnection = cancellation::trackConnection)
            }
            if (!text.trimStart().startsWith("#EXTM3U")) throw IllegalStateException("播放清单无效")
            if (Regex("#EXT-X-MEDIA:.*TYPE=(?:AUDIO|SUBTITLES)").containsMatchIn(text)) preserveTimeline = true
            val variants = PlaybackMatchers.manifestVariants(text, finalUrl)
            if (variants.isNotEmpty() || text.contains("#EXT-X-ENDLIST")) {
                warmCache.warm(current, finalUrl, text.toByteArray(Charsets.UTF_8), "application/vnd.apple.mpegurl")
            }
            if (variants.isNotEmpty()) {
                qualities = variants.mapNotNull { it.quality }.distinct().sortedByDescending { it.rank }
                val desired = (quality ?: Quality.Q1080P).rank
                val chosen = variants.sortedWith(
                    compareBy<ManifestVariant> { abs((it.quality?.rank ?: desired) - desired) }
                        .thenByDescending { it.bandwidth }
                ).first()
                selectedQuality = chosen.quality
                current = chosen.url
                continue
            }

            val filtered = if (preserveTimeline) text else PlaylistFilter.filterPlaylist(text, finalUrl, source, rules).text
            val duration = DurationReader.hls(filtered)
            val chapters = ChapterReader.hls(filtered)
            val first = if (text.contains("#EXTINF:")) {
                warmCache.firstSegment(text, finalUrl, source, preserveTimeline)
            } else null
            if (first == null) throw IllegalStateException("播放清单没有媒体分片")

            val keyDeferred = first.keyUrl?.let { kUrl ->
                probeScope.async { fetchKey(kUrl, cancellation) }
            }

            val segmentStarted = System.currentTimeMillis()
            val resp = mediaFetcher?.open(first.url) ?: withContext(Dispatchers.IO) {
                PublicNetwork.openPublic(first.url, connectTimeoutMs = 8000, readTimeoutMs = 15000, onConnection = cancellation::trackConnection)
            }
            cancellation.trackResponse(resp)
            if (resp.statusCode != 200 || resp.contentType.contains("text/html", ignoreCase = true)) {
                val code = resp.statusCode
                resp.close()
                throw IllegalStateException("媒体分片不可用（$code）")
            }

            val buf = ByteArray(16384)
            val firstCount = withContext(Dispatchers.IO) { resp.stream.read(buf) }
            if (firstCount <= 0) {
                resp.close()
                throw IllegalStateException("媒体分片为空")
            }
            val opening = buf.copyOf(firstCount)
            val shared = warmCache.share(first.url, resp.finalUrl, resp.contentType, resp.contentLength)
            shared.write(opening)
            val size = AtomicLong(opening.size.toLong())
            var ended = false
            val complete = AtomicBoolean(false)
            val measuredUntil = AtomicLong(0L)
            val headParts = ArrayList<ByteArray>().apply { add(opening) }
            var shown: Quality?

            try {
                val keyBytes = keyDeferred?.await()
                fun clearBytes(): ByteArray {
                    val totalLen = headParts.sumOf { it.size }
                    val joined = ByteArray(totalLen)
                    var p = 0
                    for (part in headParts) {
                        System.arraycopy(part, 0, joined, p, part.size)
                        p += part.size
                    }
                    return if (first.iv != null && keyBytes != null) PictureSize.clearHead(joined, keyBytes, first.iv) else joined
                }

                var startBytes = if (first.sealed) null else clearBytes()
                var picture = startBytes?.let { PictureSize.pictureOf(it) }
                while (picture == null && startBytes != null &&
                    (startBytes.size < 188 || (startBytes[0].toInt() and 0xff) == 0x47) &&
                    size.get() < PICTURE_BYTES
                ) {
                    if (cancellation.cancelled) throw CancellationException("请求已取消")
                    val n = withContext(Dispatchers.IO) { resp.stream.read(buf) }
                    if (n <= 0) {
                        ended = true
                        break
                    }
                    val chunk = buf.copyOf(n)
                    size.addAndGet(n.toLong())
                    headParts.add(chunk)
                    shared.write(chunk)
                    startBytes = clearBytes()
                    picture = PictureSize.pictureOf(startBytes)
                }
                shown = picture?.let { Quality.forPicture(it.width, it.height) }
            } catch (t: Throwable) {
                resp.close()
                warmCache.finishFlow(first.url, shared, false)
                throw t
            }

            val whole = CompletableDeferred<Unit>()
            probeScope.launch {
                val startedAt = System.currentTimeMillis()
                try {
                    while (!ended) {
                        if (cancellation.cancelled || System.currentTimeMillis() - startedAt > FIRST_SEGMENT_MS) {
                            throw IllegalStateException("片源响应超时")
                        }
                        val n = resp.stream.read(buf)
                        if (n <= 0) break
                        size.addAndGet(n.toLong())
                        if (!shared.write(buf, n)) {
                            measuredUntil.set(System.currentTimeMillis())
                            warmCache.finishFlow(first.url, shared, false)
                            whole.complete(Unit)
                            return@launch
                        }
                    }
                    if (resp.contentLength > 0L && resp.contentLength != size.get()) {
                        throw IllegalStateException("媒体分片不完整")
                    }
                    complete.set(true)
                    measuredUntil.set(System.currentTimeMillis())
                    warmCache.finishFlow(first.url, shared, true)
                    whole.complete(Unit)
                } catch (t: Throwable) {
                    warmCache.finishFlow(first.url, shared, false)
                    whole.completeExceptionally(t)
                } finally {
                    resp.close()
                }
            }

            val targetUrl = if (preserveTimeline) episode.url else current
            warmCache.registerSource(targetUrl, source, preserveTimeline)
            val several = !qualities.isNullOrEmpty() && qualities.size > 1
            val label = if (several) selectedQuality else (shown ?: selectedQuality)
            val playback = Playback(
                url = targetUrl,
                format = "hls",
                sourceKey = source.key,
                quality = if (!preserveTimeline) label else null,
                qualities = if (!preserveTimeline && several) qualities else null,
                duration = duration.seconds,
                durationSource = duration.source,
                intro = chapters.intro,
                outro = chapters.outro,
            )
            return@withTimeout Reached(playback, whole, shown ?: selectedQuality, margin = {
                DeliverySpeed.playbackMargin(first.seconds, resp.contentLength.takeIf { it > 0L }, size.get(),
                    (measuredUntil.get().takeIf { it > 0L } ?: System.currentTimeMillis()) - segmentStarted, complete.get())
            }) { size.get() }
        }
        throw IllegalStateException("播放清单嵌套过深")
    }

    private suspend fun fetchKey(url: String, cancellation: MediaRequestCancellation): ByteArray = withContext(Dispatchers.IO) {
        val resp = PublicNetwork.openPublic(url, connectTimeoutMs = 8000, readTimeoutMs = 9000, onConnection = cancellation::trackConnection)
        try {
            if (resp.statusCode != 200) throw IllegalStateException("播放密钥不可用（${resp.statusCode}）")
            val key = PublicNetwork.readLimited(resp.stream, resp.contentLength, 4096)
            if (key.size != 16) throw IllegalStateException("播放密钥无效")
            warmCache.warm(url, resp.finalUrl, key, resp.contentType.ifEmpty { "application/octet-stream" })
            key
        } finally {
            resp.close()
        }
    }

    private suspend fun candidates(item: MediaItem, hints: WorkHints, complete: Boolean): List<Candidate> {
        val key = workKey(item, hints)
        var start = false
        val lookup = synchronized(lock) {
            cache[key]?.takeIf { it.expires > System.currentTimeMillis() }?.let { return it.value }
            inflight[key] ?: CatalogueLookup().also { inflight[key] = it; start = true }
        }
        if (start) searchScope.launch {
            try {
                val found = searchCandidates(item, hints) { early -> lookup.first.complete(early) }
                synchronized(lock) {
                    if (cache.size >= 128 && key !in cache) cache.remove(cache.keys.first())
                    cache[key] = CachedCandidates(found, System.currentTimeMillis() + if (found.isEmpty()) 20_000L else 5 * 60_000L)
                    inflight.remove(key)
                }
                lookup.first.complete(found)
                lookup.complete.complete(found)
            } catch (error: Throwable) {
                synchronized(lock) { inflight.remove(key) }
                lookup.first.completeExceptionally(error)
                lookup.complete.completeExceptionally(error)
            }
        }
        return if (complete) lookup.complete.await() else lookup.first.await()
    }

    suspend fun mp4Chapters(url: String): ChapterMarks {
        val cancellation = MediaRequestCancellation()
        val pending = probeScope.async {
            ChapterReader.mp4 { offset, count ->
                val range = mapOf("Range" to "bytes=$offset-${offset + count - 1}")
                val response = mediaFetcher?.open(url, range) ?: PublicNetwork.openPublic(url, headers = range,
                    connectTimeoutMs = 3000, readTimeoutMs = 3000, onConnection = cancellation::trackConnection)
                cancellation.trackResponse(response)
                try {
                    if (response.statusCode == 200 && offset == 0L || response.statusCode == 206 &&
                        response.contentRange?.startsWith("bytes $offset-") == true) {
                        val buffer = ByteArray(count)
                        var read = 0
                        while (read < count) {
                            val n = response.stream.read(buffer, read, count - read)
                            if (n <= 0) break
                            read += n
                        }
                        buffer.copyOf(read)
                    } else ByteArray(0)
                } finally { response.close() }
            }
        }
        return try {
            withTimeout(5000L) { pending.await() }
        } finally {
            if (!pending.isCompleted) {
                pending.cancel()
                probeScope.launch { cancellation.cancel() }
            }
        }
    }

    private suspend fun getCatalogueJson(url: String, timeoutMs: Int): Map<String, Any?> {
        // DNS and HttpURLConnection may block beyond their socket timeouts. Bound the real
        // workers and let the caller's deadline cancel its wait, even during DNS.
        val connection = MediaRequestCancellation()
        val request = searchScope.async {
            searchLimiter.withPermit {
                val text = catalogueFetcher?.getJson(url, timeoutMs) ?: PublicNetwork.getText(
                    url, connectTimeoutMs = timeoutMs, readTimeoutMs = timeoutMs,
                    onConnection = connection::trackConnection,
                ).first
                Json.parseObject(text)
            }
        }
        try {
            return request.await()
        } finally {
            if (!request.isCompleted) {
                request.cancel()
                searchScope.launch { connection.cancel() }
            }
        }
    }

    private fun parseVod(raw: Any?): RawVod {
        val m = Json.row(raw)
        return RawVod(
            vodId = m["vod_id"]?.toString(),
            vodName = m["vod_name"] as? String,
            vodYear = m["vod_year"]?.toString(),
            typeName = m["type_name"] as? String,
            vodPlayFrom = m["vod_play_from"] as? String,
            vodPlayUrl = m["vod_play_url"] as? String,
            vodArea = m["vod_area"] as? String,
        )
    }

    private fun apiUrl(api: String, params: Map<String, String>): String {
        val sep = if ('?' in api) '&' else '?'
        val query = params.entries.joinToString("&") { (k, v) ->
            "${URLEncoder.encode(k, "UTF-8")}=${URLEncoder.encode(v, "UTF-8")}"
        }
        return "$api$sep$query"
    }

    private suspend fun searchCandidates(
        item: MediaItem,
        hints: WorkHints,
        early: (List<Candidate>) -> Unit,
    ): List<Candidate> = coroutineScope {
        var successes = 0
        val enabled = rules.sources.filter { it.enabled }.sortedByDescending { it.priority }

        suspend fun ask(source: PlaySource): List<Candidate> {
            val asked = catalogueClock()
            if (synchronized(lock) { (failures[source.key]?.until ?: 0L) > asked }) {
                throw IllegalStateException("片源冷却中")
            }
            try {
                val found = ArrayList<Candidate>()
                val seen = HashSet<String>()
                withTimeout(catalogueTimeoutMs.toLong()) {
                    searchLoop@ for (term in PlaybackMatchers.workTerms(item.title, hints.aliases ?: emptyList())) {
                        for (page in 1..2) {
                            val url = apiUrl(source.api, mapOf("ac" to "videolist", "wd" to term, "pg" to page.toString()))
                            val payload = getCatalogueJson(url, catalogueTimeoutMs)
                            val listRaw = payload["list"] as? List<*> ?: throw IllegalStateException("片源数据格式无效")
                            synchronized(lock) { successes++ }
                            val matchingRows = listRaw.asSequence().map(::parseVod)
                                .filter { it.vodId !in source.excludedRecordIds && PlaybackMatchers.matchRecord(item, it, hints) != null }.take(4)
                            for (raw in matchingRows) {
                                val id = raw.vodId ?: continue
                                if (!seen.add(id)) continue
                                val exact = if (!raw.vodPlayUrl.isNullOrEmpty()) {
                                    raw
                                } else {
                                    val detailUrl = apiUrl(source.api, mapOf("ac" to "videolist", "ids" to id))
                                    val detailPayload = getCatalogueJson(detailUrl, catalogueTimeoutMs)
                                    Json.list(detailPayload["list"]).map { parseVod(it) }.firstOrNull { it.vodId == id }
                                } ?: continue
                                val match = PlaybackMatchers.matchRecord(item, exact, hints) ?: continue
                                val range = match.range
                                val lines = PlaybackMatchers.parseLines(exact.vodPlayFrom ?: "", exact.vodPlayUrl ?: "")
                                    .mapNotNull { l -> if (range != null) PlaybackMatchers.runOf(l, range) else l }
                                if (lines.isNotEmpty()) {
                                    found.add(
                                        Candidate(
                                            source = source,
                                            vodId = id,
                                            lines = lines,
                                            dubbed = PlaybackMatchers.titleKey(exact.vodName ?: "").dubbed,
                                            weak = match.weak,
                                            run = range?.let { it.last - it.first + 1 },
                                        )
                                    )
                                }
                            }
                            if (found.isNotEmpty()) break@searchLoop
                            val pagecount = (payload["pagecount"] as? Number)?.toInt() ?: payload["pagecount"]?.toString()?.toIntOrNull() ?: 1
                            if (page >= pagecount) break
                        }
                    }
                }
                synchronized(lock) { failures.remove(source.key) }
                return found
            } catch (t: Throwable) {
                if (t is CancellationException && t !is TimeoutCancellationException) throw t
                synchronized(lock) {
                    val before = failures[source.key]
                    val count = (before?.count ?: 0) + 1
                    val unreachable = PublicNetwork.unreachableHere(t)
                    failures[source.key] = FailureState(
                        count = count,
                        until = if (count >= 3) catalogueClock() + 30_000L else 0L,
                        since = if (unreachable) 0L else before?.since ?: catalogueClock(),
                    )
                }
                onFailureLog(source.key, "search: ${t.message}", catalogueClock() - asked)
                throw t
            }
        }

        val headReady = CompletableDeferred<List<Candidate>?>()
        val headLock = Any()
        val got = ArrayList<Candidate>()
        val awaited = synchronized(lock) {
            enabled.filter { !failures.containsKey(it.key) }.map { it.key }.toHashSet()
        }
        var graceJob: kotlinx.coroutines.Job? = null
        var remaining = enabled.size
        if (remaining == 0) headReady.complete(null)

        val jobs = enabled.map { source ->
            async(Dispatchers.IO) {
                val res = runCatching { ask(source) }
                currentCoroutineContext().ensureActive()
                var completeWith: List<Candidate>? = null
                synchronized(headLock) {
                    awaited.remove(source.key)
                    remaining--
                    val value = res.getOrNull()
                    if (value != null && value.isNotEmpty()) {
                        got.addAll(value)
                        if (graceJob == null && !headReady.isCompleted) {
                            graceJob = launch {
                                delay(searchGraceMs)
                                val snap = synchronized(headLock) { got.toList() }
                                headReady.complete(snap)
                            }
                        }
                    }
                    if (got.isNotEmpty() && (awaited.isEmpty() || remaining == 0) && !headReady.isCompleted) {
                        completeWith = got.toList()
                    } else if (remaining == 0 && got.isEmpty()) {
                        headReady.complete(null)
                    }
                }
                completeWith?.let {
                    graceJob?.cancel()
                    headReady.complete(it)
                }
                res
            }
        }

        val head = headReady.await()
        if (head != null) early(PlaybackMatchers.rank(head))

        val results = jobs.map { it.await() }
        var found = results.flatMap { it.getOrElse { emptyList() } }
        if (found.isNotEmpty()) return@coroutineScope PlaybackMatchers.rank(found)
        val stumbled = ArrayList<PlaySource>()
        val silent = ArrayList<PlaySource>()
        for (i in enabled.indices) {
            if (results[i].isFailure) {
                val s = enabled[i]
                silent.add(s)
                val f = synchronized(lock) { failures[s.key] }
                if ((f?.count ?: 0) < 3 && f?.since != 0L) stumbled.add(s)
            }
        }
        if (found.isEmpty() && stumbled.isNotEmpty()) {
            delay(requeryDelayMs)
            val again = stumbled.map { s -> async(Dispatchers.IO) { runCatching { ask(s) } } }.map { it.await() }
            found = again.flatMap { it.getOrElse { emptyList() } }
            val stillSilent = ArrayList<PlaySource>()
            for (s in silent) {
                val idx = stumbled.indexOf(s)
                if (idx < 0 || again[idx].isFailure) stillSilent.add(s)
            }
            silent.clear()
            silent.addAll(stillSilent)
        }
        if (found.isEmpty() && synchronized(lock) { successes == 0 }) {
            throw IllegalStateException(Copy.Extra.UNAVAILABLE)
        }
        val unanswered = silent.any { s ->
            val f = synchronized(lock) { failures[s.key] }
            f != null && catalogueClock() - f.since < SOURCE_GONE_AFTER
        }
        if (found.isEmpty() && unanswered) {
            throw IllegalStateException(Copy.Extra.UNAVAILABLE)
        }
        PlaybackMatchers.rank(found)
    }

    companion object {
        private const val REACH_MS = 10_000L
        private const val FIRST_SEGMENT_MS = 25_000L
        private const val LIVE_MAX = 8
        private const val SET_BACK_MS = 10 * 60_000L
        private const val PICTURE_BYTES = 64 * 1024L
        private const val RESOLVED_MS = 3 * 60_000L
        private const val SOURCE_GONE_AFTER = 2 * 60_000L
        private val TRANSIENT_RE = Regex("网络请求失败|请求已取消|片源响应超时|（5\\d\\d）|媒体分片不完整|媒体分片为空")
    }
}
