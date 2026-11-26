package app.panda.tv.model

enum class MediaType(val wire: String) {
    TV("tv"),
    MOVIE("movie"),
    VARIETY("variety"),
    ANIME("anime"),
    DOC("doc");

    companion object {
        fun fromWire(value: String?): MediaType? = values().firstOrNull { it.wire == value }
    }
}

enum class Quality(val label: String, val rank: Int) {
    Q4K("4K", 4),
    Q1080P("1080P", 3),
    Q720P("720P", 2),
    Q480P("480P", 1);

    companion object {
        fun fromWire(value: String?): Quality? = values().firstOrNull { it.label == value }
        fun forPicture(width: Int, height: Int): Quality? = when {
            width >= 3800 || height >= 2100 -> Q4K
            width >= 1900 || height >= 1000 -> Q1080P
            width >= 1200 || height >= 700 -> Q720P
            width >= 600 || height >= 400 -> Q480P
            else -> null
        }
    }
}

data class Person(
    val name: String,
    val role: String? = null,
)

data class Credit(
    val name: String,
    val role: String? = null,
    val id: String? = null,
    val photo: String? = null,
)

data class PersonInfo(
    val id: String,
    val name: String,
    val photo: String? = null,
)

data class MediaItem(
    val id: String,
    val title: String,
    val type: MediaType,
    val genres: List<String>,
    val poster: String? = null,
    val backdrop: String? = null,
    val year: Int? = null,
    val region: String? = null,
    val score: Double? = null,
    val tagline: String? = null,
    val originalTitle: String? = null,
    val synopsis: String? = null,
    val runtime: Int? = null,
    val episodes: Int? = null,
    val status: String? = null,
    val unit: String? = null,
    val episodeTitles: List<String>? = null,
    val directors: List<String>? = null,
    val cast: List<Person>? = null,
    val people: List<Credit>? = null,
)

data class RankBoard(
    val title: String,
    val moreType: MediaType,
    val items: List<MediaItem>,
)

sealed class Shelf(val id: String) {
    class ContinueShelf(id: String = "continue") : Shelf(id)
    data class RowShelf(
        val shelfId: String,
        val kind: String, // "poster" | "wide"
        val title: String,
        val moreType: MediaType,
        val items: List<MediaItem>,
    ) : Shelf(shelfId)

    data class RankShelf(
        val shelfId: String = "rank",
        val boards: List<RankBoard>,
    ) : Shelf(shelfId)
}

data class HomeFeed(
    val hero: List<MediaItem>,
    val shelves: List<Shelf>,
)

data class ChannelQuery(
    val sort: String = "hot",
    val genre: String? = null,
    val region: String? = null,
    val year: String? = null,
)

data class ChannelFilters(
    val genres: List<String>,
    val regions: List<String>,
    val years: List<String>,
)

data class Page<T>(
    val items: List<T>,
    val next: String?,
)

data class TimeRange(
    val start: Double,
    val end: Double,
)

data class HealthHint(
    val score: Double,
    val cooled: Boolean,
    val lastFailure: String? = null,
)

data class Playback(
    val url: String,
    val format: String, // "hls" | "mp4"
    val sourceKey: String? = null,
    val quality: Quality? = null,
    val qualities: List<Quality>? = null,
    val intro: TimeRange? = null,
    val outro: Double? = null,
    val duration: Double? = null,
    val durationSource: String? = null,
    val manifestFingerprint: String? = null,
    val healthHint: HealthHint? = null,
)

data class HistoryEntry(
    val id: String,
    val episode: Int,
    val position: Double,
    val duration: Double,
    val at: Long,
)

data class Settings(
    val autoNext: Boolean = true,
    val skipIntro: Boolean = true,
    val quality: Quality = Quality.Q1080P,
    val speed: Double = 1.0,
    val volume: Double = 0.8,
    val muted: Boolean = false,
)

data class UserState(
    val favorites: List<String>,
    val history: List<HistoryEntry>,
    val searches: List<String>,
    val settings: Settings,
)

data class Availability(
    val episodes: Int? = null,
    val episodeTitles: List<String>? = null,
)

data class SourceOption(
    val key: String,
    val name: String,
)

data class PlaySources(
    val list: List<SourceOption>,
    val current: String? = null,
)

sealed class StateAction {
    data class ToggleFavorite(val id: String) : StateAction()
    data class RecordHistory(val entry: HistoryEntry) : StateAction()
    data class RemoveHistory(val id: String) : StateAction()
    object ClearHistory : StateAction()
    data class AddSearch(val query: String) : StateAction()
    object ClearSearches : StateAction()
    data class UpdateSettings(
        val autoNext: Boolean? = null,
        val skipIntro: Boolean? = null,
        val quality: Quality? = null,
        val speed: Double? = null,
        val volume: Double? = null,
        val muted: Boolean? = null,
    ) : StateAction()
}

object Constants {
    val QUALITIES = listOf(Quality.Q4K, Quality.Q1080P, Quality.Q720P, Quality.Q480P)
    val SPEEDS = listOf(0.75, 1.0, 1.25, 1.5, 2.0)
    val DEFAULT_SETTINGS = Settings()
    const val EPISODE_RANGE_SIZE = 50
    const val RELATED_MAX = 14
    const val SUGGEST_MAX = 8
    const val RECENT_SEARCH_MAX = 8
    const val HOT_SEARCH_MAX = 10
    const val FINISHED_RATIO = 0.95
    const val PLAYER_IDLE_MS = 3500L
    const val UPNEXT_SECONDS = 10
    const val SEEK_STEP_SECONDS = 10
    const val OSD_MS = 900L
    const val SKIP_EDGE_SECONDS = 2
    const val HISTORY_SAVE_SECONDS = 5
}
