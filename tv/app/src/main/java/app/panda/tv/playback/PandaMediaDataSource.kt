package app.panda.tv.playback

import android.net.Uri
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.BaseDataSource
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import app.panda.tv.net.PublicNetwork
import app.panda.tv.net.PublicResponse
import java.io.ByteArrayInputStream
import java.io.EOFException
import java.io.IOException
import java.io.InputStream
import java.net.URI
import java.util.Locale

@UnstableApi
class PandaMediaDataSource(
    private val cache: WarmMediaCache,
    private val rules: SourceRules,
) : BaseDataSource(true) {

    class Factory(
        private val cache: WarmMediaCache,
        private val rules: SourceRules,
    ) : DataSource.Factory {
        override fun createDataSource(): DataSource = PandaMediaDataSource(cache, rules)
    }

    private var activeUri: Uri? = null
    private var memoryStream: ByteArrayInputStream? = null
    private var sharedReader: SharedSegmentFlow.Reader? = null
    private var response: PublicResponse? = null
    private var streamBytesLeft: Long = C.LENGTH_UNSET.toLong()
    private var maxSegmentCap: Long = Long.MAX_VALUE
    private var totalRead = 0L
    private var opened = false

    override fun open(dataSpec: DataSpec): Long {
        val rawUrl = dataSpec.uri.toString()
        val url = try {
            PublicNetwork.validatePublicUrl(rawUrl).toString()
        } catch (e: Exception) {
            throw IOException(e.message ?: "不支持的播放地址", e)
        }

        transferInitializing(dataSpec)
        val fullRequest = dataSpec.position == 0L && dataSpec.length == C.LENGTH_UNSET.toLong()
        val ctx = cache.sourceFor(url)

        if (fullRequest) {
            val warmed = cache.getWarmed(url, evictIfLargeSegment = true)
            if (warmed != null) {
                activeUri = Uri.parse(warmed.finalUrl)
                val outBytes = if (isPlaylist(warmed.finalUrl, warmed.type)) {
                    processPlaylist(warmed.body.toString(Charsets.UTF_8), warmed.finalUrl, ctx)
                } else {
                    warmed.body
                }
                memoryStream = ByteArrayInputStream(outBytes)
                opened = true
                transferStarted(dataSpec)
                return outBytes.size.toLong()
            }

            val flow = cache.getShared(url)
            if (flow != null) {
                activeUri = Uri.parse(url)
                sharedReader = flow.openReader()
                opened = true
                transferStarted(dataSpec)
                return if (flow.length > 0L) flow.length else C.LENGTH_UNSET.toLong()
            }
        }

        val reqHeaders = HashMap<String, String>()
        if (dataSpec.position > 0L || dataSpec.length != C.LENGTH_UNSET.toLong()) {
            val end = if (dataSpec.length != C.LENGTH_UNSET.toLong()) (dataSpec.position + dataSpec.length - 1L).toString() else ""
            reqHeaders["Range"] = "bytes=${dataSpec.position}-$end"
        }

        val resp = PublicNetwork.openPublic(
            rawUrl = url,
            method = "GET",
            headers = reqHeaders,
            connectTimeoutMs = 10000,
            readTimeoutMs = 20000,
        )
        if (resp.statusCode !in 200..299) {
            val code = resp.statusCode
            resp.close()
            throw IOException("上游服务暂不可用（$code）")
        }
        val lowerType = resp.contentType.lowercase(Locale.US)
        if (lowerType.contains("text/html") || lowerType.contains("application/json")) {
            resp.close()
            throw IOException("上游未返回媒体")
        }
        activeUri = Uri.parse(resp.finalUrl)

        if (isPlaylist(resp.finalUrl, resp.contentType) && fullRequest) {
            val rawBytes = try {
                PublicNetwork.readLimited(resp.stream, resp.contentLength, 4 * 1024 * 1024)
            } finally {
                resp.close()
            }
            val outBytes = processPlaylist(rawBytes.toString(Charsets.UTF_8), resp.finalUrl, ctx)
            memoryStream = ByteArrayInputStream(outBytes)
            opened = true
            transferStarted(dataSpec)
            return outBytes.size.toLong()
        }

        response = resp
        if (resp.statusCode == 200 && dataSpec.position > 0L) {
            skipFully(resp.stream, dataSpec.position)
        }
        val path = try { URI(resp.finalUrl).rawPath ?: "" } catch (_: Exception) { "" }
        maxSegmentCap = if (path.endsWith(".mp4", ignoreCase = true)) Long.MAX_VALUE else SharedSegmentFlow.SEGMENT_BYTES
        streamBytesLeft = if (dataSpec.length != C.LENGTH_UNSET.toLong()) {
            dataSpec.length
        } else if (resp.contentLength > 0L) {
            if (resp.statusCode == 200 && dataSpec.position > 0L) maxOf(0L, resp.contentLength - dataSpec.position) else resp.contentLength
        } else {
            C.LENGTH_UNSET.toLong()
        }
        opened = true
        transferStarted(dataSpec)
        return streamBytesLeft
    }

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        if (length == 0) return 0
        memoryStream?.let { ms ->
            val n = ms.read(buffer, offset, length)
            if (n < 0) return C.RESULT_END_OF_INPUT
            bytesTransferred(n)
            return n
        }
        sharedReader?.let { sr ->
            val n = sr.read(buffer, offset, length)
            if (n < 0) return C.RESULT_END_OF_INPUT
            bytesTransferred(n)
            return n
        }
        val resp = response ?: return C.RESULT_END_OF_INPUT
        if (streamBytesLeft == 0L) return C.RESULT_END_OF_INPUT
        val want = if (streamBytesLeft != C.LENGTH_UNSET.toLong()) minOf(length.toLong(), streamBytesLeft).toInt() else length
        val n = resp.stream.read(buffer, offset, want)
        if (n < 0) {
            if (streamBytesLeft > 0L) throw EOFException("媒体分片不完整")
            return C.RESULT_END_OF_INPUT
        }
        totalRead += n
        if (totalRead > maxSegmentCap) throw IOException("资源超过大小限制")
        if (streamBytesLeft != C.LENGTH_UNSET.toLong()) streamBytesLeft -= n
        bytesTransferred(n)
        return n
    }

    override fun getUri(): Uri? = activeUri

    override fun close() {
        activeUri = null
        memoryStream = null
        sharedReader?.close()
        sharedReader = null
        response?.close()
        response = null
        streamBytesLeft = C.LENGTH_UNSET.toLong()
        maxSegmentCap = Long.MAX_VALUE
        totalRead = 0L
        if (opened) {
            opened = false
            transferEnded()
        }
    }

    private fun processPlaylist(rawText: String, finalUrl: String, ctx: Pair<PlaySource, Boolean>?): ByteArray {
        val clean = if (rawText.isNotEmpty() && rawText[0] == '\uFEFF') rawText.substring(1) else rawText
        if (!clean.trimStart().startsWith("#EXTM3U")) throw IOException("播放清单格式无效")
        val source = ctx?.first
        val preserve = (ctx?.second ?: false) || PlaylistFilter.hasSynchronizedTracks(clean)
        val filteredText = if (source != null) {
            val res = PlaylistFilter.filterPlaylist(clean, finalUrl, source, rules, preserve)
            cache.recordDiagnostic(source.key, res)
            res.text
        } else {
            clean
        }
        val rewritten = PlaylistFilter.absolutizePlaylist(filteredText, finalUrl) { childUrl ->
            if (source != null) cache.registerSource(childUrl, source, preserve)
        }
        return rewritten.toByteArray(Charsets.UTF_8)
    }

    private fun isPlaylist(url: String, contentType: String): Boolean {
        val path = try { URI(url).rawPath ?: "" } catch (_: Exception) { url }
        return path.endsWith(".m3u8", ignoreCase = true) ||
            contentType.contains("mpegurl", ignoreCase = true)
    }

    private fun skipFully(stream: InputStream, bytesToSkip: Long) {
        var remaining = bytesToSkip
        val scratch = ByteArray(8192)
        while (remaining > 0L) {
            val n = stream.read(scratch, 0, minOf(scratch.size.toLong(), remaining).toInt())
            if (n < 0) throw IOException("Unexpected end of stream")
            remaining -= n
        }
    }
}
