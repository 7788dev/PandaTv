package app.panda.tv.playback

import app.panda.tv.model.Json
import app.panda.tv.model.MediaItem
import app.panda.tv.model.MediaType
import app.panda.tv.net.PublicResponse
import java.io.ByteArrayInputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.Base64
import java.util.concurrent.atomic.AtomicInteger

internal val admissionMovie = MediaItem("db-41", "回归影片", MediaType.MOVIE, emptyList(), year = 2023)
internal val admissionSerial = admissionMovie.copy(id = "db-42", title = "回归剧集", type = MediaType.TV, episodes = 3)
internal val mp4Opening = byteArrayOf(0, 0, 0, 24) + "ftypisom".toByteArray() + byteArrayOf(0, 0, 0, 0) + "isommp42".toByteArray()
internal fun admissionRules(keys: List<String>) = SourceRules(3, "2026-11-24T00:00:00Z", .15, 45.0,
    keys.mapIndexed { i, key -> PlaySource(key, key, "https://$key.catalog.example.org/api", true, 20 - i, emptyList(), emptyList()) })

internal class ObservedStream(bytes: ByteArray) : ByteArrayInputStream(bytes) {
    var closed = false
    var received = 0
    override fun read(buffer: ByteArray, offset: Int, length: Int): Int = super.read(buffer, offset, length).also { if (it > 0) received += it }
    override fun close() { closed = true; super.close() }
}
internal fun admissionResponse(url: String, bytes: ByteArray = mp4Opening, type: String = "video/mp4", status: Int = 200, length: Long = bytes.size.toLong(), disconnected: AtomicInteger = AtomicInteger()): Pair<PublicResponse, ObservedStream> {
    val stream = ObservedStream(bytes)
    val connection = object : HttpURLConnection(URL(url)) {
        override fun disconnect() { disconnected.incrementAndGet() }
        override fun connect() { connected = true }
        override fun usingProxy() = false
    }
    return PublicResponse(status, url, type, length, null, null, stream, connection) to stream
}
internal fun admissionCatalogue(item: MediaItem = admissionMovie, hlsSource: String? = null) = CatalogueFetcher { url, _ ->
    val key = URL(url).host.substringBefore('.')
    val format = if (key == hlsSource) "m3u8" else "mp4"
    val episodes = if (item.type == MediaType.MOVIE) listOf(1) else listOf(1, 2, 3)
    Json.stringify(mapOf("pagecount" to 1, "list" to listOf(mapOf("vod_id" to 1, "vod_name" to item.title, "vod_year" to "2023",
        "type_name" to if (item.type == MediaType.MOVIE) "电影" else "电视剧", "vod_play_from" to format,
        "vod_play_url" to episodes.joinToString("#") { "第${it}集${'$'}https://$key.media.example.org/episode-$it.$format" }))))
}
internal fun codecHead(quality: String): ByteArray {
    val data = requireNotNull(AdmissionFixtureMarker::class.java.classLoader?.getResourceAsStream("media-heads.json")).use { Json.parseObject(it.bufferedReader().readText()) }
    val row = Json.list(data["heads"]).map(Json::row).first { it["source"] == "generated-$quality" }
    return Base64.getDecoder().decode(row["head"] as String)
}
private class AdmissionFixtureMarker
