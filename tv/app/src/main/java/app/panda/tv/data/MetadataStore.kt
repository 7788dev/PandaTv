package app.panda.tv.data

import app.panda.tv.model.Json
import app.panda.tv.model.MediaType
import app.panda.tv.storage.writeAtomic
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

private const val CACHE_PREFIX = "{\"version\":1,\"records\":["
private val RECORD_BUDGET = 4 * 1024 * 1024 - (CACHE_PREFIX + "]}").toByteArray(Charsets.UTF_8).size

data class CatalogRecord(
    val item: app.panda.tv.model.MediaItem,
    val kind: String,
    val totalEpisodes: Int? = null,
    val tags: List<String>? = null,
    val aliases: List<String>? = null,
    val updatedAt: Long,
)

class MetadataStore(
    private val cacheDir: File? = null,
    private val onWarning: (DataWarning) -> Unit = {},
) {
    private val lock = Any()
    private val writeLock = Any()
    private val entries = LinkedHashMap<String, CatalogRecord>(128, 0.75f, true)
    @Volatile
    private var loaded = false

    fun ensureLoaded() {
        if (loaded) return
        synchronized(lock) {
            if (loaded) return
            loadLocked()
            loaded = true
        }
    }

    fun get(id: String): CatalogRecord? {
        ensureLoaded()
        return synchronized(lock) { entries[id] }
    }

    fun values(): List<CatalogRecord> {
        ensureLoaded()
        return synchronized(lock) { entries.values.toList() }
    }

    fun set(records: List<Normalized>) {
        ensureLoaded()
        val now = System.currentTimeMillis()
        synchronized(lock) {
            for (value in records) {
                val existing = entries[value.item.id]
                val prev = existing?.item
                val cur = value.item
                val mergedItem = cur.copy(
                    // A plain movie/tv card carries format, not evidence that a
                    // previously verified thematic category disappeared.
                    type = if (existing?.kind == value.kind && cur.type.wire == value.kind) prev!!.type else cur.type,
                    genres = if (cur.genres.isNotEmpty()) cur.genres else prev?.genres ?: emptyList(),
                    poster = cur.poster ?: prev?.poster,
                    backdrop = cur.backdrop ?: prev?.backdrop,
                    year = cur.year ?: prev?.year,
                    region = cur.region ?: prev?.region,
                    score = cur.score ?: prev?.score,
                    originalTitle = cur.originalTitle ?: prev?.originalTitle,
                    synopsis = cur.synopsis ?: prev?.synopsis,
                    runtime = cur.runtime ?: prev?.runtime,
                    directors = cur.directors ?: prev?.directors,
                    cast = cur.cast ?: prev?.cast,
                )
                entries.remove(mergedItem.id)
                entries[mergedItem.id] = CatalogRecord(
                    item = mergedItem,
                    kind = value.kind,
                    totalEpisodes = value.totalEpisodes ?: existing?.totalEpisodes,
                    tags = value.tags ?: existing?.tags,
                    aliases = value.aliases ?: existing?.aliases,
                    updatedAt = now,
                )
            }
            while (entries.size > 1200) {
                val oldest = entries.keys.firstOrNull() ?: break
                entries.remove(oldest)
            }
        }
    }

    suspend fun flush() {
        val dir = cacheDir ?: return
        withContext(Dispatchers.IO) {
            ensureLoaded()
            synchronized(writeLock) {
                try {
                    // Take the snapshot after acquiring the writer, so an older
                    // flush cannot replace a newer file when two writes overlap.
                    val snapshot = synchronized(lock) { entries.values.toList() }
                    val encoded = ArrayList<String>()
                    var remaining = RECORD_BUDGET
                    for (record in snapshot.asReversed()) {
                        val json = encodeRecord(record)
                        val bytes = json.toByteArray(Charsets.UTF_8).size
                        if (bytes > RECORD_BUDGET) continue
                        val cost = bytes + if (encoded.isEmpty()) 0 else 1
                        if (cost > remaining) break
                        remaining -= cost
                        encoded.add(json)
                    }
                    val body = encoded.asReversed().joinToString(",", CACHE_PREFIX, "]}")
                    writeAtomic(File(dir, "metadata-v1.json"), body.toByteArray(Charsets.UTF_8))
                } catch (_: Exception) {
                    onWarning(DataWarning("STORAGE", "metadata:save", "Metadata cache could not be saved", System.currentTimeMillis()))
                }
            }
        }
    }

    private fun encodeRecord(rec: CatalogRecord): String {
        val it = rec.item
        return Json.stringify(linkedMapOf(
            "kind" to rec.kind,
            "updatedAt" to rec.updatedAt,
            "totalEpisodes" to rec.totalEpisodes,
            "tags" to rec.tags,
            "aliases" to rec.aliases,
            "item" to linkedMapOf<String, Any?>(
                "id" to it.id,
                "title" to it.title,
                "type" to it.type.wire,
                "genres" to it.genres,
                "poster" to it.poster,
                "backdrop" to it.backdrop,
                "year" to it.year,
                "region" to it.region,
                "score" to it.score,
                "originalTitle" to it.originalTitle,
                "synopsis" to it.synopsis,
                "runtime" to it.runtime,
                "directors" to it.directors,
                "cast" to it.cast?.map { p ->
                    linkedMapOf("name" to p.name, "role" to p.role)
                },
            ),
        ))
    }

    private fun loadLocked() {
        val dir = cacheDir ?: return
        val file = File(dir, "metadata-v1.json")
        if (!file.exists()) return
        try {
            if (file.length() > 12L * 1024L * 1024L) throw IllegalStateException("oversized")
            val content = Json.parseObject(file.readText(Charsets.UTF_8))
            if ((content["version"] as? Number)?.toInt() != 1 || content["records"] !is List<*>) {
                throw IllegalStateException("invalid cache")
            }
            for (raw in Json.list(content["records"]).takeLast(2500)) {
                val rec = Json.row(raw)
                val it = Json.row(rec["item"])
                val kind = rec["kind"] as? String
                if (kind != "tv" && kind != "movie") continue
                val restored = Normalize.normalize(
                    mapOf(
                        "id" to Json.text(it["id"])?.removePrefix("db-"),
                        "title" to it["title"],
                        "type" to kind,
                        "genres" to it["genres"],
                        "pic" to mapOf("large" to it["poster"]),
                        "photos" to (it["backdrop"]?.let { bg -> listOf(bg) } ?: emptyList<Any?>()),
                        "year" to it["year"],
                        "rating" to mapOf("value" to it["score"]),
                        "countries" to (Json.text(it["region"])?.let { r -> listOf(r) } ?: emptyList<Any?>()),
                        "original_title" to it["originalTitle"],
                        "intro" to it["synopsis"],
                        "durations" to (Json.positiveInt(it["runtime"])?.let { rt -> listOf("${rt}分钟") } ?: emptyList<Any?>()),
                        "actors" to Json.list(it["cast"]).map { p ->
                            val pr = Json.row(p)
                            mapOf("name" to pr["name"], "character" to pr["role"])
                        },
                        "directors" to Json.list(it["directors"]).map { n -> mapOf("name" to n) },
                        "episodes_count" to rec["totalEpisodes"],
                        "tags" to rec["tags"],
                        "aka" to rec["aliases"],
                    )
                ) ?: continue
                val updatedAt = (rec["updatedAt"] as? Number)?.toLong()?.takeIf { it > 0L } ?: continue
                val storedType = MediaType.fromWire(it["type"] as? String)
                val item = if (storedType != null) restored.item.copy(type = storedType) else restored.item
                entries[item.id] = CatalogRecord(
                    item = item,
                    kind = restored.kind,
                    totalEpisodes = restored.totalEpisodes,
                    tags = restored.tags,
                    aliases = restored.aliases,
                    updatedAt = updatedAt,
                )
            }
        } catch (_: Exception) {
            onWarning(DataWarning("STORAGE", "metadata:load", "Metadata cache was invalid or unreadable", System.currentTimeMillis()))
        }
    }
}
