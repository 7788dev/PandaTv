package app.panda.tv.data

import app.panda.tv.model.Constants
import app.panda.tv.model.Json

data class HotQuery(val title: String, val score: Double)

object HotSearch {
    fun hotQueries(raw: Any?, board: String): List<HotQuery> {
        val root = Json.row(raw)
        val data = Json.row(root["data"])
        if (root["success"] != true || data["cards"] !is List<*>) {
            throw DataError(DataErrorCode.INVALID_RESPONSE, "Invalid hot-search response")
        }
        val entries = Json.list(data["cards"]).flatMap { card ->
            val c = Json.row(card)
            if (c["component"] == "tabImgInfoList") {
                Json.list(c["content"]).flatMap { grp -> Json.list(Json.row(grp)["content"]) }
            } else emptyList()
        }
        val result = entries.mapNotNull { entry ->
            val value = Json.row(entry)
            val heat = Json.row(value["hotScore"])
            val title = Json.text(value["title"]) ?: return@mapNotNull null
            val score = Json.positive(heat["value"]) ?: return@mapNotNull null
            if (value["Sa"] != "fyb_$board" || title.length > 100 || heat["desc"] != "热搜指数") return@mapNotNull null
            HotQuery(title, score)
        }
        if (result.isEmpty()) {
            throw DataError(DataErrorCode.INVALID_RESPONSE, "No verified movie search queries")
        }
        return result
    }

    fun combineHotQueries(boards: List<List<HotQuery>>): List<String> {
        val seen = HashSet<String>()
        return boards.flatten()
            .sortedByDescending { it.score }
            .mapNotNull { if (seen.add(it.title)) it.title else null }
            .take(Constants.HOT_SEARCH_MAX)
    }
}
