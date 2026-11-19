package app.panda.tv.data

import app.panda.tv.model.Json
import app.panda.tv.model.MediaType
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.util.UUID

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

    fun set(records: List<Normalized>) {
        ensureLoaded()
        val now = System.currentTimeMillis()
        synchronized(lock) {
            for (value in records) {
                val existing = entries[value.item.id]
                val prev = existing?.item
                val cur = value.item
                val mergedItem = cur.copy(
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
        ensureLoaded()
        val snapshot = synchronized(lock) { entries.values.toList() }
        withContext(Dispatchers.IO) {
            try {
                val records = snapshot.toMutableList()
                fun encodeList(): String {
                    val root = linkedMapOf<String, Any?>(
                        "version" to 1,
                        "records" to records.map { rec ->
                            val it = rec.item
                            linkedMapOf<String, Any?>(
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
                            )
                        },
                    )
                    return Json.stringify(root)
                }

                var body = encodeList()
                while (body.toByteArray(Charsets.UTF_8).size > 4 * 1024 * 1024 && records.isNotEmpty()) {
                    records.removeAt(0)
                    body = encodeList()
                }
                dir.mkdirs()
                val target = File(dir, "metadata-v1.json")
                val tmp = File(dir, "metadata-v1.json.${UUID.randomUUID()}.tmp")
                tmp.writeText(body, Charsets.UTF_8)
                if (!tmp.renameTo(target)) {
                    target.writeText(body, Charsets.UTF_8)
                    tmp.delete()
                }
            } catch (_: Exception) {
                onWarning(DataWarning("STORAGE", "metadata:save", "Metadata cache could not be saved", System.currentTimeMillis()))
            }
        }
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
