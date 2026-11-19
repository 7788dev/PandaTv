package app.panda.tv.data

import app.panda.tv.model.Base64Codec
import app.panda.tv.model.ChannelFilters
import app.panda.tv.model.ChannelQuery
import app.panda.tv.model.Copy
import app.panda.tv.model.Credit
import app.panda.tv.model.HomeFeed
import app.panda.tv.model.Json
import app.panda.tv.model.MediaItem
import app.panda.tv.model.MediaType
import app.panda.tv.model.Page
import app.panda.tv.model.PersonInfo
import app.panda.tv.model.RankBoard
import app.panda.tv.model.Shelf
import app.panda.tv.playback.WorkHints
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.net.URLEncoder
import java.util.UUID
import kotlin.math.min

class PartialPage(val rows: Int, val total: Int) :
    RuntimeException("Listing incomplete: $rows of $total titles")

class DoubanDataSource(
    private val cacheDir: File? = null,
    fetcher: MetadataFetcher? = null,
    private val partialWaitMs: Long = 800L,
    private val homeRetryMs: List<Long> = listOf(2000L, 6000L),
    private val onWarning: (DataWarning) -> Unit = {},
) {
    private val http = DoubanHttp(fetcher = fetcher)
    private val store = MetadataStore(cacheDir, ::warn)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val lock = Any()
    private val warnings = ArrayList<DataWarning>()
    private val flights = HashMap<String, CompletableDeferred<MediaItem>>()

    @Volatile
    private var homeState: CachedHome? = null
    @Volatile
    private var homeLoaded = false
    @Volatile
    private var homeInFlight = false

    private data class CachedHome(val at: Long, val lists: Map<String, List<MediaItem>>)

    private data class Cursor(
        val fingerprint: String,
        val offsets: MutableList<Int>,
        val done: MutableList<Boolean>,
    )

    fun getWarnings(): List<DataWarning> = synchronized(lock) { warnings.toList() }

    fun workHints(id: String): WorkHints {
        val rawId = Normalize.subjectId(id)
        val rec = store.get("db-$rawId")
        return WorkHints(
            single = rec?.kind == "movie",
            aliases = rec?.aliases,
            totalEpisodes = rec?.totalEpisodes,
        )
    }

    suspend fun flush() {
        store.flush()
    }

    private fun warn(w: DataWarning) {
        synchronized(lock) {
            if (warnings.size >= 50) warnings.removeAt(0)
            warnings.add(w)
        }
        onWarning(w)
    }

    private fun diagnostic(op: String, t: Throwable) {
        val code = if (t is DataError) t.code.name else "UPSTREAM"
        val msg = if (t is DataError) t.message ?: "Upstream error" else "Optional metadata unavailable"
        warn(DataWarning(code, op, msg, System.currentTimeMillis()))
    }

    private fun endpoint(path: String, params: Map<String, String> = emptyMap()): String {
        if (params.isEmpty()) return "$BASE/$path"
        val query = params.entries.joinToString("&") { (k, v) ->
            "${URLEncoder.encode(k, "UTF-8")}=${URLEncoder.encode(v, "UTF-8")}"
        }
        return "$BASE/$path?$query"
    }

    private suspend fun page(
        path: String,
        params: Map<String, String>,
        start: Int,
        count: Int,
        field: String,
    ): Map<String, Any?> {
        val merged = LinkedHashMap<String, String>().apply {
            put("start", start.toString())
            put("count", count.toString())
            putAll(params)
        }
        return http.json(endpoint(path, merged), LIST_TTL, { value ->
            val rows = Normalize.requiredArray(value, field)
            val response = Json.row(value)
            val total = Json.positiveInt(response["total"]) ?: 0
            if (rows.size < min(count, total - start)) {
                throw PartialPage(rows.size, total)
            }
            response
        }, patient = true)
    }

    private suspend fun listing(
        path: String,
        params: Map<String, String>,
        start: Int,
        field: String = "items",
    ): Map<String, Any?> {
        suspend fun read(offset: Int, level: Int): Map<String, Any?> {
            val size = READ_SIZES[level]
            var partial: PartialPage? = null
            for (again in listOf(true, false)) {
                try {
                    return page(path, params, offset, size, field)
                } catch (e: PartialPage) {
                    partial = e
                    if (again && partialWaitMs > 0L) delay(partialWaitMs)
                }
            }
            val nextLevel = level + 1
            if (partial == null || nextLevel >= READ_SIZES.size) {
                throw DataError(DataErrorCode.TIMEOUT, partial?.message ?: "Listing incomplete", retryable = true)
            }
            val smaller = READ_SIZES[nextLevel]
            val offsets = ArrayList<Int>()
            var at = offset
            val limit = min(offset + size, partial.total)
            while (at < limit) {
                offsets.add(at)
                at += smaller
            }
            val parts = coroutineScope {
                offsets.map { o -> async { read(o, nextLevel) } }.map { it.await() }
            }
            val combinedRows = parts.flatMap { Normalize.requiredArray(it, field) }
            val out = LinkedHashMap(parts.firstOrNull() ?: emptyMap())
            out["count"] = size
            out[field] = combinedRows
            return out
        }
        return read(start, 0)
    }

    private fun keep(values: List<Normalized>): List<MediaItem> {
        store.set(values)
        return values.mapNotNull { store.get(it.item.id)?.item }
    }

    suspend fun home(onUpdate: ((HomeFeed) -> Unit)? = null): HomeFeed {
        ensureHomeLoaded()
        val known = homeState
        if (known != null) {
            if (System.currentTimeMillis() - known.at >= LIST_TTL) {
                refreshHomeInBackground(known.lists, onUpdate)
            }
            return buildFeed(known.lists, known.lists["movies"] ?: emptyList())
        }
        return loadFreshHome(onUpdate)
    }

    private fun refreshHomeInBackground(saved: Map<String, List<MediaItem>>, onUpdate: ((HomeFeed) -> Unit)?) {
        if (homeInFlight) return
        homeInFlight = true
        scope.launch {
            try {
                val results = fetchAllHomeLists(saved = true)
                if (results.errors.isNotEmpty()) {
                    warn(DataWarning("CACHED", "home", "Showing the saved home feed; a new one could not be read", System.currentTimeMillis()))
                    return@launch
                }
                val complete = results.lists
                homeState = CachedHome(System.currentTimeMillis(), complete)
                saveHome(homeState!!)
                if (complete != saved) {
                    onUpdate?.invoke(buildFeed(complete, complete["movies"] ?: emptyList()))
                }
            } finally {
                homeInFlight = false
            }
        }
    }

    private suspend fun loadFreshHome(onUpdate: ((HomeFeed) -> Unit)?): HomeFeed = coroutineScope {
        val lists = HashMap<String, List<MediaItem>>()
        val errors = HashMap<String, Throwable>()
        val topReady = CompletableDeferred<Result<HomeFeed>>()
        var revealed = 0
        var answered = false
        val stateLock = Any()

        suspend fun again(read: suspend () -> List<MediaItem>): List<MediaItem> {
            for (pause in homeRetryMs) {
                try {
                    return read()
                } catch (e: DataError) {
                    if (!e.retryable) throw e
                    delay(pause)
                }
            }
            return read()
        }

        fun shownLocked(): HomeFeed {
            val visible = LinkedHashMap<String, List<MediaItem>>()
            for (name in HOME_LISTS) visible[name] = emptyList()
            for (idx in 0 until revealed) {
                for (name in HOME_SHELVES[idx]) {
                    visible[name] = lists[name] ?: emptyList()
                }
            }
            return buildFeed(visible, lists["movies"] ?: emptyList())
        }

        val tasks = mapOf<String, suspend () -> List<MediaItem>>(
            "tv" to { channel(MediaType.TV, ChannelQuery(sort = "hot")).items.take(14) },
            "movies" to { chartItems("movie_latest", 20).take(14) },
            "tvRank" to { again { chartItems("tv_hot").take(5) } },
            "movieRank" to { again { chartItems("movie_real_time_hotest").take(5) } },
            "animeRank" to { again { chartItems("tv_animation").take(5) } },
            "variety" to { again { channel(MediaType.VARIETY, ChannelQuery(sort = "hot")).items.take(14) } },
            "anime" to { again { channel(MediaType.ANIME, ChannelQuery(sort = "hot")).items.take(14) } },
            "doc" to { again { channel(MediaType.DOC, ChannelQuery(sort = "hot")).items.take(14) } },
        )

        val jobs = tasks.map { (name, block) ->
            async(Dispatchers.IO) {
                try {
                    val items = block()
                    synchronized(stateLock) { lists[name] = items }
                } catch (t: Throwable) {
                    synchronized(stateLock) {
                        lists[name] = emptyList()
                        errors[name] = t
                    }
                }
                var updateFeed: HomeFeed? = null
                synchronized(stateLock) {
                    if (!topReady.isCompleted && "tv" in lists && "movies" in lists) {
                        val topErr = errors["tv"] ?: errors["movies"]
                        if (topErr != null) {
                            topReady.complete(Result.failure(topErr))
                        } else {
                            answered = true
                            while (revealed < HOME_SHELVES.size && HOME_SHELVES[revealed].all { it in lists }) {
                                revealed++
                            }
                            topReady.complete(Result.success(shownLocked()))
                        }
                    } else if (answered) {
                        val before = revealed
                        while (revealed < HOME_SHELVES.size && HOME_SHELVES[revealed].all { it in lists }) {
                            revealed++
                        }
                        if (revealed > before) updateFeed = shownLocked()
                    }
                }
                updateFeed?.let { onUpdate?.invoke(it) }
            }
        }

        val initial = topReady.await()
        if (initial.isFailure) {
            for (j in jobs) j.cancel()
            throw initial.exceptionOrNull()!!
        }

        scope.launch {
            for (j in jobs) j.join()
            if (errors.isEmpty()) {
                val snap = synchronized(stateLock) { HashMap(lists) }
                val cached = CachedHome(System.currentTimeMillis(), snap)
                homeState = cached
                saveHome(cached)
            } else {
                for ((name, err) in errors) diagnostic("home:$name", err)
            }
        }
        initial.getOrThrow()
    }

    private data class AllListsResult(
        val lists: Map<String, List<MediaItem>>,
        val errors: Map<String, Throwable>,
    )

    private suspend fun fetchAllHomeLists(saved: Boolean): AllListsResult = coroutineScope {
        val lists = LinkedHashMap<String, List<MediaItem>>()
        val errors = LinkedHashMap<String, Throwable>()
        val pauses = if (saved) emptyList() else homeRetryMs
        suspend fun runPart(name: String, block: suspend () -> List<MediaItem>) {
            for (pause in pauses) {
                try {
                    val items = block()
                    synchronized(lists) { lists[name] = items }
                    return
                } catch (e: DataError) {
                    if (!e.retryable) {
                        synchronized(lists) { lists[name] = emptyList(); errors[name] = e }
                        return
                    }
                    delay(pause)
                }
            }
            try {
                val items = block()
                synchronized(lists) { lists[name] = items }
            } catch (t: Throwable) {
                synchronized(lists) { lists[name] = emptyList(); errors[name] = t }
            }
        }
        val jobs = listOf(
            async { runPart("tv") { channel(MediaType.TV, ChannelQuery(sort = "hot")).items.take(14) } },
            async { runPart("movies") { chartItems("movie_latest", 20).take(14) } },
            async { runPart("tvRank") { chartItems("tv_hot").take(5) } },
            async { runPart("movieRank") { chartItems("movie_real_time_hotest").take(5) } },
            async { runPart("animeRank") { chartItems("tv_animation").take(5) } },
            async { runPart("variety") { channel(MediaType.VARIETY, ChannelQuery(sort = "hot")).items.take(14) } },
            async { runPart("anime") { channel(MediaType.ANIME, ChannelQuery(sort = "hot")).items.take(14) } },
            async { runPart("doc") { channel(MediaType.DOC, ChannelQuery(sort = "hot")).items.take(14) } },
        )
        for (j in jobs) j.join()
        AllListsResult(lists, errors)
    }

    private fun buildFeed(lists: Map<String, List<MediaItem>>, heroMovies: List<MediaItem>): HomeFeed {
        val tv = lists["tv"] ?: emptyList()
        val movies = lists["movies"] ?: emptyList()
        val hero = (tv.take(3) + heroMovies.take(2)).filter { it.poster != null || it.backdrop != null }
        val boards = listOf(
            RankBoard(Copy.Data.RANK_TV, MediaType.TV, lists["tvRank"] ?: emptyList()),
            RankBoard(Copy.Data.RANK_MOVIE, MediaType.MOVIE, lists["movieRank"] ?: emptyList()),
            RankBoard(Copy.Data.RANK_ANIME, MediaType.ANIME, lists["animeRank"] ?: emptyList()),
        ).filter { it.items.isNotEmpty() }

        val shelves = ArrayList<Shelf>()
        shelves.add(Shelf.ContinueShelf())
        if (tv.isNotEmpty()) shelves.add(Shelf.RowShelf("hot-tv", "poster", Copy.Data.HOME_HOT_TV, MediaType.TV, tv))
        if (boards.isNotEmpty()) shelves.add(Shelf.RankShelf("rank", boards))
        if (movies.isNotEmpty()) shelves.add(Shelf.RowShelf("new-movie", "poster", Copy.Data.HOME_NEW_MOVIE, MediaType.MOVIE, movies))
        val variety = lists["variety"] ?: emptyList()
        if (variety.isNotEmpty()) shelves.add(Shelf.RowShelf("variety", "wide", Copy.Nav.VARIETY, MediaType.VARIETY, variety))
        val anime = lists["anime"] ?: emptyList()
        if (anime.isNotEmpty()) shelves.add(Shelf.RowShelf("anime", "poster", Copy.Nav.ANIME, MediaType.ANIME, anime))
        val doc = lists["doc"] ?: emptyList()
        if (doc.isNotEmpty()) shelves.add(Shelf.RowShelf("doc", "wide", Copy.Nav.DOC, MediaType.DOC, doc))
        return HomeFeed(hero, shelves)
    }

    private suspend fun saveHome(cached: CachedHome) {
        val dir = cacheDir ?: return
        store.flush()
        withContext(Dispatchers.IO) {
            try {
                val listsObj = linkedMapOf<String, Any?>()
                for (name in HOME_LISTS) {
                    listsObj[name] = (cached.lists[name] ?: emptyList()).map { it.id }
                }
                val body = Json.stringify(
                    linkedMapOf(
                        "version" to 1,
                        "at" to cached.at,
                        "lists" to listsObj,
                    )
                )
                dir.mkdirs()
                val path = File(dir, HOME_FILE)
                val tmp = File(dir, "$HOME_FILE.${UUID.randomUUID()}.tmp")
                tmp.writeText(body, Charsets.UTF_8)
                if (!tmp.renameTo(path)) {
                    path.writeText(body, Charsets.UTF_8)
                    tmp.delete()
                }
            } catch (_: Exception) {
                warn(DataWarning("STORAGE", "home:save", "Home feed could not be saved", System.currentTimeMillis()))
            }
        }
    }

    private fun ensureHomeLoaded() {
        if (homeLoaded) return
        synchronized(lock) {
            if (homeLoaded) return
            homeLoaded = true
            val dir = cacheDir ?: return
            val file = File(dir, HOME_FILE)
            if (!file.exists()) return
            try {
                val saved = Json.parseObject(file.readText(Charsets.UTF_8))
                val at = (saved["at"] as? Number)?.toLong()?.takeIf { it > 0L } ?: return
                if ((saved["version"] as? Number)?.toInt() != 1) return
                store.ensureLoaded()
                val rawLists = Json.row(saved["lists"])
                val lists = LinkedHashMap<String, List<MediaItem>>()
                for (name in HOME_LISTS) {
                    val ids = Json.list(rawLists[name]).mapNotNull { it as? String }.take(14)
                    val items = ids.mapNotNull { store.get(it)?.item }
                    if (items.isEmpty() || items.size * 2 < ids.size) return
                    lists[name] = items
                }
                val now = System.currentTimeMillis()
                homeState = CachedHome(if (at > now) 0L else at, lists)
            } catch (_: Exception) {
            }
        }
    }

    private suspend fun chartItems(collection: String, count: Int = 10): List<MediaItem> {
        val values = http.json(
            endpoint("subject_collection/$collection/items", mapOf("start" to "0", "count" to count.toString())),
            LIST_TTL,
            { Normalize.requiredArray(it, "subject_collection_items") },
        )
        return keep(values.mapNotNull { Normalize.normalize(it) })
    }

    fun filters(type: MediaType): ChannelFilters = ChannelFilters(
        genres = Taxonomy.GENRES[type] ?: emptyList(),
        regions = Taxonomy.REGIONS[type] ?: emptyList(),
        years = Taxonomy.yearChoices(),
    )

    suspend fun channel(type: MediaType, query: ChannelQuery, cursor: String? = null): Page<MediaItem> {
        if (query.sort !in setOf("hot", "new", "score")) {
            throw DataError(DataErrorCode.INVALID_INPUT, "Invalid channel query")
        }
        val badFilter = Regex("[,，\\s]")
        for (value in listOfNotNull(query.genre, query.region, query.year)) {
            if (value.length > 40 || badFilter.containsMatchIn(value)) {
                throw DataError(DataErrorCode.INVALID_INPUT, "Invalid channel filter")
            }
        }
        if (query.year != null && Taxonomy.yearSpan(query.year) == null) {
            throw DataError(DataErrorCode.INVALID_INPUT, "Invalid year filter")
        }
        val lanes = Taxonomy.LANES[type] ?: throw DataError(DataErrorCode.INVALID_INPUT, "Invalid channel")
        val fingerprint = Json.stringify(
            listOf(type.wire, query.sort, query.genre ?: "", query.region ?: "", query.year ?: "")
        )
        val state = if (cursor != null) {
            decodeCursor(cursor, fingerprint, lanes.size)
        } else {
            Cursor(fingerprint, MutableList(lanes.size) { 0 }, MutableList(lanes.size) { false })
        }

        val sortCode = when (query.sort) {
            "new" -> "R"
            "score" -> "S"
            else -> "U"
        }

        suspend fun readLane(index: Int): List<Normalized> {
            val lane = lanes[index]
            val tags = (lane.tags + listOfNotNull(query.genre, query.region, query.year)).distinct()
            val response = listing(
                "${lane.kind}/recommend",
                mapOf("sort" to sortCode, "tags" to tags.joinToString(",")),
                state.offsets[index],
            )
            val rows = Normalize.requiredArray(response, "items")
            val total = Json.positiveInt(response["total"])
            state.offsets[index] += Json.positiveInt(response["count"]) ?: PAGE_SIZE
            state.done[index] = rows.isEmpty() || total == null || state.offsets[index] >= total
            return rows.mapNotNull { Normalize.normalize(it, lane.kind) }.filter { value ->
                val it = value.item
                val typeOk = if (type == MediaType.MOVIE) value.kind == "movie" else it.type == type
                typeOk && Taxonomy.matchesYear(it.year, query.year) && Taxonomy.matchesRegion(it.region, query.region)
            }
        }

        val merged = ArrayList<Normalized>()
        val seen = HashSet<String>()
        for (round in 0 until PAGE_ROUNDS) {
            if (merged.size >= PAGE_TARGET || state.done.all { it }) break
            val open = lanes.indices.filter { !state.done[it] }
            val results = coroutineScope {
                open.map { idx -> async { runCatching { readLane(idx) } } }.map { it.await() }
            }
            val failed = results.filter { it.isFailure }
            val buckets = results.map { it.getOrElse { emptyList() } }
            if (failed.isNotEmpty() && merged.isEmpty() && buckets.all { it.isEmpty() }) {
                throw failed.first().exceptionOrNull()!!
            }
            for (i in results.indices) {
                val err = results[i].exceptionOrNull()
                if (err != null) diagnostic("channel:${type.wire}:${lanes[open[i]].kind}", err)
            }
            val maxLen = buckets.maxOfOrNull { it.size } ?: 0
            for (i in 0 until maxLen) {
                for (bucket in buckets) {
                    val v = bucket.getOrNull(i) ?: continue
                    if (seen.add(v.item.id)) merged.add(v)
                }
            }
            if (failed.isNotEmpty()) break
        }
        if (lanes.size > 1 && query.sort == "score") merged.sortByDescending { it.item.score ?: 0.0 }
        if (lanes.size > 1 && query.sort == "new") merged.sortByDescending { it.item.year ?: 0 }
        val items = keep(merged)
        val next = if (state.done.all { it }) null else encodeCursor(state)
        return Page(items, next)
    }

    private fun encodeCursor(state: Cursor): String {
        val raw = Json.stringify(
            linkedMapOf(
                "fingerprint" to state.fingerprint,
                "offsets" to state.offsets,
                "done" to state.done,
            )
        )
        return Base64Codec.encodeUrl(raw.toByteArray(Charsets.UTF_8))
    }

    private fun decodeCursor(cursor: String, fingerprint: String, laneCount: Int): Cursor {
        try {
            if (cursor.length > 2000) error("too long")
            val decoded = Json.parseObject(Base64Codec.decode(cursor).toString(Charsets.UTF_8))
            if (decoded["fingerprint"] != fingerprint) error("mismatch")
            val offsetsRaw = Json.list(decoded["offsets"])
            val doneRaw = Json.list(decoded["done"])
            if (offsetsRaw.size != laneCount || doneRaw.size != laneCount) error("size")
            val offsets = offsetsRaw.map { n ->
                val v = (n as? Number)?.toInt() ?: error("offset")
                if (v < 0 || v > 10000 || n.toDouble() != v.toDouble()) error("range")
                v
            }.toMutableList()
            val done = doneRaw.map { it as? Boolean ?: error("done") }.toMutableList()
            return Cursor(fingerprint, offsets, done)
        } catch (_: Exception) {
            throw DataError(DataErrorCode.INVALID_INPUT, "Invalid or outdated channel cursor")
        }
    }

    suspend fun detail(id: String): MediaItem {
        val rawId = Normalize.subjectId(id)
        var existing: CompletableDeferred<MediaItem>?
        var created: CompletableDeferred<MediaItem>? = null
        synchronized(flights) {
            existing = flights[rawId]
            if (existing == null) {
                created = CompletableDeferred()
                flights[rawId] = created!!
            }
        }
        if (existing != null) return existing!!.await()
        val deferred = created!!
        return try {
            val loaded = loadDetail(rawId)
            deferred.complete(loaded)
            loaded
        } catch (t: Throwable) {
            deferred.completeExceptionally(t)
            throw t
        } finally {
            synchronized(flights) {
                if (flights[rawId] === deferred) flights.remove(rawId)
            }
        }
    }

    private suspend fun loadDetail(rawId: String): MediaItem = coroutineScope {
        val known = store.get("db-$rawId")
        val first = known?.kind ?: "movie"
        val kinds = listOf(first, if (first == "movie") "tv" else "movie")
        var detail: Normalized? = null
        for (kind in kinds) {
            try {
                detail = http.json(endpoint("$kind/$rawId"), DETAIL_TTL, { value ->
                    val normalized = Normalize.normalize(value, kind)
                    if (normalized == null || normalized.item.id != "db-$rawId") {
                        throw DataError(DataErrorCode.NOT_FOUND, "Douban subject not found")
                    }
                    normalized
                })
                break
            } catch (e: DataError) {
                if (e.code != DataErrorCode.NOT_FOUND || kind != first) throw e
            }
        }
        val norm = detail ?: throw DataError(DataErrorCode.NOT_FOUND, "Douban subject not found")
        val path = "${norm.kind}/$rawId"
        val creditsTask = async {
            runCatching {
                http.json(endpoint("$path/credits"), DETAIL_TTL, { Normalize.principalCredits(it) })
            }
        }
        val photosTask = async {
            runCatching {
                http.json(endpoint("$path/photos", mapOf("count" to "8")), DETAIL_TTL, {
                    Normalize.requiredArray(it, "photos")
                    it
                })
            }
        }
        val creditsRes = creditsTask.await()
        val photosRes = photosTask.await()

        val principal = creditsRes.getOrNull()
        creditsRes.exceptionOrNull()?.let { diagnostic("credits:$rawId", it) }

        val cast = if (principal != null && principal.cast.isNotEmpty()) principal.cast else norm.item.cast?.take(LEAD_ACTORS)
        val backdrop = photosRes.fold(
            onSuccess = { Normalize.landscapePhoto(it) },
            onFailure = { diagnostic("photos:$rawId", it); norm.item.backdrop },
        )
        val mergedItem = norm.item.copy(
            cast = cast ?: norm.item.cast,
            backdrop = backdrop,
        )
        val stored = keep(listOf(norm.copy(item = mergedItem))).firstOrNull() ?: mergedItem
        val people: List<Credit>? = principal?.people?.takeIf { it.isNotEmpty() }
        if (people != null) stored.copy(people = people) else stored
    }

    suspend fun person(id: String): PersonInfo {
        val rawId = Normalize.personId(id)
        return try {
            http.json(endpoint("celebrity/$rawId"), DETAIL_TTL, { value ->
                val source = Json.row(value)
                val cover = Json.row(source["cover"])
                val name = Json.text(source["title"])
                if (name == null || name.length > 100) {
                    throw DataError(DataErrorCode.INVALID_RESPONSE, "Missing name in person response")
                }
                val photo = Normalize.portraitUrl(Json.row(cover["normal"])["url"])
                    ?: Normalize.portraitUrl(Json.row(cover["large"])["url"])
                PersonInfo(rawId, name, photo)
            })
        } catch (e: DataError) {
            if (e.code == DataErrorCode.NOT_FOUND) throw DataError(DataErrorCode.UNAVAILABLE, Copy.Extra.PERSON_NOT_FOUND)
            throw e
        }
    }

    suspend fun personWorks(id: String, cursor: String? = null): Page<MediaItem> {
        val rawId = Normalize.personId(id)
        if (cursor != null) {
            val n = cursor.toIntOrNull()
            if (!Regex("^\\d{1,5}$").matches(cursor) || n == null || n % PAGE_SIZE != 0) {
                throw DataError(DataErrorCode.INVALID_INPUT, "Invalid works cursor")
            }
        }
        val start = cursor?.toInt() ?: 0
        return try {
            val response = listing("celebrity/$rawId/works", emptyMap(), start, field = "works")
            val values = Normalize.requiredArray(response, "works").mapNotNull { entry ->
                Normalize.normalize(Json.row(entry)["work"])
            }
            val total = Json.positiveInt(response["total"]) ?: 0
            val next = if (start + PAGE_SIZE < total) (start + PAGE_SIZE).toString() else null
            Page(keep(values), next)
        } catch (e: DataError) {
            if (e.code == DataErrorCode.NOT_FOUND) throw DataError(DataErrorCode.UNAVAILABLE, Copy.Extra.PERSON_NOT_FOUND)
            throw e
        }
    }

    suspend fun related(id: String): List<MediaItem> {
        val rawId = Normalize.subjectId(id)
        if (store.get("db-$rawId") == null) detail(rawId)
        val kind = store.get("db-$rawId")?.kind ?: "movie"
        val values = http.json(
            endpoint("$kind/$rawId/recommendations", mapOf("count" to "14")),
            LIST_TTL,
            { Normalize.requiredArray(it) },
        )
        return keep(values.mapNotNull { Normalize.normalize(it, kind) }.filter { it.item.id != "db-$rawId" }.take(14))
    }

    suspend fun byIds(ids: List<String>): List<MediaItem> {
        if (ids.size > 2500) throw DataError(DataErrorCode.INVALID_INPUT, "Too many metadata IDs")
        val checked = ids.map { "db-${Normalize.subjectId(it)}" }
        val output = ArrayList<MediaItem>(checked.size)
        for (id in checked) {
            val cached = store.get(id)
            if (cached != null) {
                if (System.currentTimeMillis() - cached.updatedAt > DETAIL_TTL) {
                    warn(DataWarning("CACHED", "byIds:$id", "Showing saved metadata; freshness is not guaranteed", System.currentTimeMillis()))
                }
                output.add(cached.item)
            } else {
                try {
                    output.add(detail(id))
                } catch (e: DataError) {
                    if (e.code == DataErrorCode.NOT_FOUND) diagnostic("byIds:$id", e) else throw e
                }
            }
        }
        return output
    }

    private suspend fun searchPage(q: String, start: Int, count: Int): Map<String, Any?> {
        return http.json(endpoint("search/movie", mapOf("q" to q, "start" to start.toString(), "count" to count.toString())), SEARCH_TTL, { value ->
            Normalize.requiredArray(value, "items")
            val r = Json.row(value)
            if (Json.text(r["banned"]) != null) throw DataError(DataErrorCode.UPSTREAM, "Search query was rejected")
            r
        })
    }

    suspend fun search(query: String): List<MediaItem> {
        if (query.length > 100) throw DataError(DataErrorCode.INVALID_INPUT, "Invalid search query")
        val q = query.trim()
        if (q.isEmpty()) return emptyList()
        val first = searchPage(q, 0, 50)
        val total = Json.positiveInt(first["total"]) ?: 0
        val extraStarts = listOf(50, 100, 150).filter { it < total }
        val pages = if (extraStarts.isEmpty()) {
            listOf(first)
        } else {
            val rest = coroutineScope {
                extraStarts.map { s -> async { searchPage(q, s, 50) } }.map { it.await() }
            }
            listOf(first) + rest
        }
        val seen = HashSet<String>()
        val deduped = pages.flatMap { Normalize.requiredArray(it, "items") }
            .mapNotNull { Normalize.normalize(it) }
            .filter { seen.add(it.item.id) }
        return keep(deduped)
    }

    suspend fun suggest(query: String): List<MediaItem> {
        if (query.length > 100) throw DataError(DataErrorCode.INVALID_INPUT, "Invalid search query")
        val q = query.trim()
        if (q.isEmpty()) return emptyList()
        val page = searchPage(q, 0, 8)
        return keep(Normalize.requiredArray(page, "items").mapNotNull { Normalize.normalize(it) }.take(8))
    }

    suspend fun hotSearches(): List<String> = coroutineScope {
        val movie = async {
            http.json("https://top.baidu.com/api/board?platform=wise&tab=movie", HOT_TTL, { HotSearch.hotQueries(it, "movie") })
        }
        val teleplay = async {
            http.json("https://top.baidu.com/api/board?platform=wise&tab=teleplay", HOT_TTL, { HotSearch.hotQueries(it, "teleplay") })
        }
        HotSearch.combineHotQueries(listOf(movie.await(), teleplay.await()))
    }

    companion object {
        private const val BASE = "https://m.douban.com/rexxar/api/v2"
        private const val LIST_TTL = 10 * 60_000L
        private const val DETAIL_TTL = 24 * 60 * 60_000L
        private const val SEARCH_TTL = 2 * 60_000L
        private const val HOT_TTL = 15 * 60_000L
        private const val PAGE_SIZE = 30
        private const val PAGE_TARGET = 18
        private const val PAGE_ROUNDS = 4
        private const val LEAD_ACTORS = 6
        private const val HOME_FILE = "home-v1.json"
        private val READ_SIZES = listOf(PAGE_SIZE, 10, 5)
        private val HOME_LISTS = listOf("tv", "movies", "variety", "anime", "doc", "tvRank", "movieRank", "animeRank")
        private val HOME_SHELVES = listOf(
            listOf("tv"),
            listOf("tvRank", "movieRank", "animeRank"),
            listOf("movies"),
            listOf("variety"),
            listOf("anime"),
            listOf("doc"),
        )
    }
}
