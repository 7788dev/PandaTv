package app.panda.tv.data

import app.panda.tv.model.Json
import app.panda.tv.net.PublicNetwork

data class TvRelease(val version: String, val page: String)

object TvUpdates {
    private const val REPOSITORY = "https://github.com/7788dev/PandaTv"
    private const val RELEASES = "https://api.github.com/repos/7788dev/PandaTv/releases"
    private const val PAGE_SIZE = 30
    private val apk = Regex("""^Panda-TV-(\d{1,6}\.\d{1,6}\.\d{1,6})\.apk$""")

    fun compareVersions(left: String, right: String): Int {
        val a = left.split('.').map(String::toInt)
        val b = right.split('.').map(String::toInt)
        for (i in 0..2) if (a[i] != b[i]) return a[i].compareTo(b[i])
        return 0
    }

    fun latest(readPage: (Int) -> String = { page ->
        PublicNetwork.getText("$RELEASES?per_page=$PAGE_SIZE&page=$page",
            headers = mapOf("Accept" to "application/vnd.github+json"),
            connectTimeoutMs = 5000, readTimeoutMs = 6000, limitBytes = 2 * 1024 * 1024).first
    }): TvRelease? {
        var page = 1
        var latest: TvRelease? = null
        do {
            val releases = Json.parse(readPage(page)) as? List<*> ?: error("更新数据格式无效")
            for (value in releases) {
                val release = Json.row(value)
                if (release["draft"] != false || release["prerelease"] != false) continue
                val url = (release["html_url"] as? String)?.takeIf { it.startsWith("$REPOSITORY/releases/tag/") } ?: continue
                for (asset in Json.list(release["assets"]).map(Json::row)) {
                    if (asset["state"] != "uploaded" || (asset["size"] as? Number)?.toLong()?.let { it > 0L } != true) continue
                    val version = apk.matchEntire(asset["name"] as? String ?: "")?.groupValues?.get(1) ?: continue
                    if (latest == null || compareVersions(version, latest.version) > 0) latest = TvRelease(version, url)
                }
            }
            page++
        } while (releases.size == PAGE_SIZE)
        return latest
    }
}
