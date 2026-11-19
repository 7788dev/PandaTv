package app.panda.tv.data

import app.panda.tv.model.Credit
import app.panda.tv.model.Json
import app.panda.tv.model.MediaItem
import app.panda.tv.model.MediaType
import app.panda.tv.model.Person
import java.net.URI
import java.util.Locale
import kotlin.math.abs
import kotlin.math.min

data class Normalized(
    val item: MediaItem,
    val kind: String, // "movie" | "tv"
    val totalEpisodes: Int? = null,
    val tags: List<String>? = null,
    val aliases: List<String>? = null,
)

data class SubtitleParts(
    val year: Int? = null,
    val region: String? = null,
    val genres: List<String> = emptyList(),
)

data class PrincipalCredits(
    val people: List<Credit>,
    val cast: List<Person>,
)

object Normalize {
    private const val PRINCIPAL_ROWS = 8
    private val DIGITS_1_16 = Regex("^\\d{1,16}$")
    private val YEAR_4 = Regex("^\\d{4}$")
    private val RUNTIME_RE = Regex("^(\\d+)\\s*分钟$")
    private val LEGACY_CATEGORIES = setOf("电影", "电视剧", "综艺", "动漫", "纪录片")
    private val FORMAL_GENRES = (
        "剧情 喜剧 爱情 动作 科幻 悬疑 犯罪 惊悚 恐怖 冒险 奇幻 战争 历史 传记 音乐 歌舞 " +
            "武侠 灾难 西部 家庭 运动 动画 纪录片 短片 儿童 同性 古装 真人秀 脱口秀 戏曲 舞台艺术 黑色电影 情色"
        ).split(' ').toSet()
    private val VARIETY_GENRES = setOf("真人秀", "脱口秀", "综艺")

    fun subjectId(value: String): String {
        val id = if (value.startsWith("db-")) value.substring(3) else value
        if (!DIGITS_1_16.matches(id)) throw DataError(DataErrorCode.INVALID_INPUT, "Invalid Douban subject ID")
        return id
    }

    fun personId(value: String): String {
        if (!DIGITS_1_16.matches(value)) throw DataError(DataErrorCode.INVALID_INPUT, "Invalid Douban person ID")
        return value
    }

    fun imageUrl(value: Any?): String? {
        val raw = Json.text(value) ?: return null
        return try {
            val full = if (raw.startsWith("//")) "https:$raw" else raw
            val uri = URI(full)
            val scheme = uri.scheme?.lowercase(Locale.US)
            val host = uri.host?.lowercase(Locale.US) ?: return null
            if ((scheme != "http" && scheme != "https") || !uri.userInfo.isNullOrEmpty()) return null
            if (host != "doubanio.com" && !host.endsWith(".doubanio.com")) return null
            uri.toString()
        } catch (_: Exception) {
            null
        }
    }

    fun portraitUrl(value: Any?): String? {
        val url = imageUrl(value) ?: return null
        if (!url.startsWith("https:")) return null
        val path = try { URI(url).rawPath ?: "" } catch (_: Exception) { "" }
        return if (path.startsWith("/view/")) url else null
    }

    fun subtitleParts(value: Any?): SubtitleParts {
        val parts = (Json.text(value) ?: "").split('/').map { it.trim() }.toMutableList()
        val year = if (parts.isNotEmpty() && YEAR_4.matches(parts[0])) parts.removeAt(0).toInt() else null
        if (parts.isNotEmpty() && parts[0] in LEGACY_CATEGORIES) parts.removeAt(0)
        val region = parts.getOrNull(0)?.takeIf { it.isNotEmpty() }
        val genres = parts.getOrNull(1)?.split(Regex("\\s+"))?.filter { it in FORMAL_GENRES } ?: emptyList()
        return SubtitleParts(year, region, genres)
    }

    fun mediaType(kind: String, genres: List<String>, isShow: Boolean = false): MediaType {
        if ("动画" in genres) return MediaType.ANIME
        if (isShow || genres.any { it in VARIETY_GENRES }) return MediaType.VARIETY
        if ("纪录片" in genres) return MediaType.DOC
        return if (kind == "tv") MediaType.TV else MediaType.MOVIE
    }

    fun normalize(value: Any?, fallbackKind: String = "movie"): Normalized? {
        val wrapper = Json.row(value)
        val source = if (wrapper["target"] != null) Json.row(wrapper["target"]) else wrapper
        val card = Json.text(wrapper["card"])
        if (card != null && card != "subject") return null
        val rawKind = Json.text(wrapper["target_type"]) ?: Json.text(source["type"]) ?: fallbackKind
        if (rawKind != "movie" && rawKind != "tv") return null
        val id = Json.text(source["id"]) ?: (source["id"] as? Number)?.let {
            if (it.toDouble() == it.toLong().toDouble()) it.toLong().toString() else null
        }
        val title = Json.text(source["title"])
        if (id == null || !DIGITS_1_16.matches(id) || title == null || title.length > 300) return null

        val subtitle = subtitleParts(source["card_subtitle"])
        val genres = (strings(source["genres"]) + subtitle.genres).distinct()
        val pic = Json.row(source["pic"])
        val cover = Json.row(source["cover"])
        val poster = imageUrl(pic["large"])
            ?: imageUrl(pic["normal"])
            ?: imageUrl(source["cover_url"])
            ?: imageUrl(source["cover"])
            ?: imageUrl(cover["url"])

        val yearStr = (source["year"]?.let {
            if (it is Number && it.toDouble() == it.toLong().toDouble()) it.toLong().toString() else it.toString()
        }) ?: subtitle.year?.toString() ?: ""
        val year = if (YEAR_4.matches(yearStr)) yearStr.toInt() else null

        val rating = Json.row(source["rating"])
        val score = Json.positive(rating["value"] ?: source["rate"])?.takeIf { it <= 10.0 }
        val region = strings(source["countries"]).joinToString(" / ").takeIf { it.isNotEmpty() } ?: subtitle.region
        val totalEpisodes = Json.positiveInt(source["episodes_count"])
        val runtimeText = strings(source["durations"]).firstOrNull()
        val runtime = runtimeText?.let { RUNTIME_RE.matchEntire(it)?.groupValues?.get(1)?.toIntOrNull() }?.takeIf { it > 0 }
        val directors = Json.list(source["directors"]).mapNotNull { Json.text(Json.row(it)["name"]) }
        val cast = Json.list(source["actors"]).mapNotNull { p ->
            val row = Json.row(p)
            val name = Json.text(row["name"]) ?: return@mapNotNull null
            Person(name, Json.text(row["character"]))
        }
        val backdrop = Json.list(source["photos"]).firstNotNullOfOrNull { imageUrl(it) }

        val item = MediaItem(
            id = "db-$id",
            title = title,
            type = mediaType(rawKind, genres, source["is_show"] == true),
            genres = genres,
            poster = poster,
            backdrop = backdrop,
            year = year,
            region = region,
            score = score,
            originalTitle = Json.text(source["original_title"]),
            synopsis = Json.text(source["intro"]),
            runtime = runtime,
            directors = directors.takeIf { it.isNotEmpty() },
            cast = cast.takeIf { it.isNotEmpty() },
        )

        val tags = Json.list(source["tags"]).flatMap { v ->
            if (v is String) listOf(v)
            else Json.text(Json.row(v)["name"])?.split(Regex("\\s+")) ?: emptyList()
        }
        val aliases = strings(source["aka"]).filter { it.length <= 120 }.take(30)
        return Normalized(
            item = item,
            kind = rawKind,
            totalEpisodes = totalEpisodes,
            tags = tags.takeIf { it.isNotEmpty() },
            aliases = aliases.takeIf { it.isNotEmpty() },
        )
    }

    fun requiredArray(value: Any?, field: String? = null): List<Any?> {
        val target = if (field != null) Json.row(value)[field] else value
        @Suppress("UNCHECKED_CAST")
        return target as? List<Any?>
            ?: throw DataError(DataErrorCode.INVALID_RESPONSE, "Missing ${field ?: "array"} in metadata response")
    }

    fun principalCredits(value: Any?): PrincipalCredits {
        val people = ArrayList<Credit>()
        val cast = ArrayList<Person>()
        val known = LinkedHashMap<String, Int>()
        for (entry in requiredArray(value, "items").take(PRINCIPAL_ROWS)) {
            val source = Json.row(entry)
            val name = Json.text(source["name"]) ?: continue
            if (name.length > 100) continue
            val rawId = Json.text(source["id"]) ?: (source["id"] as? Number)?.let {
                if (it.toDouble() == it.toLong().toDouble()) it.toLong().toString() else ""
            } ?: ""
            val id = if (DIGITS_1_16.matches(rawId)) rawId else null
            val category = Json.text(source["category"])
            val role = (Json.text(source["simple_character"]) ?: category)?.take(200)
            if (category == "演员" && cast.none { it.name == name }) {
                cast.add(Person(name, role))
            }
            val key = id ?: "name:$name"
            val existingIdx = known[key]
            if (existingIdx != null) {
                val cur = people[existingIdx]
                if (role != null && cur.role?.split(" / ")?.contains(role) != true) {
                    val merged = if (cur.role != null) "${cur.role} / $role" else role
                    people[existingIdx] = cur.copy(role = merged)
                }
                continue
            }
            val avatar = Json.row(source["avatar"])
            val photo = portraitUrl(avatar["normal"]) ?: portraitUrl(avatar["large"])
            known[key] = people.size
            people.add(Credit(name = name, role = role, id = id, photo = photo))
        }
        return PrincipalCredits(people, cast)
    }

    fun landscapePhoto(value: Any?): String? {
        var bestUrl: String? = null
        var bestFit = Double.NEGATIVE_INFINITY
        for (p in requiredArray(value, "photos")) {
            val im = Json.row(Json.row(p)["image"])
            if (im["is_animated"] == true) continue
            val large = Json.row(im["large"])
            val width = Json.positive(large["width"]) ?: continue
            val height = Json.positive(large["height"]) ?: continue
            val url = imageUrl(large["url"]) ?: continue
            val ratio = width / height
            if (width < 600.0 || ratio < 1.3 || ratio > 2.8) continue
            val fit = min(width, 1920.0) - abs(ratio - 16.0 / 9.0) * 200.0
            if (fit > bestFit) {
                bestFit = fit
                bestUrl = url
            }
        }
        return bestUrl
    }

    private fun strings(value: Any?): List<String> =
        Json.list(value).mapNotNull { Json.text(it) }.take(100)
}
