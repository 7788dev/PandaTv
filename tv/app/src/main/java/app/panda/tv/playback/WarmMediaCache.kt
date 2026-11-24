package app.panda.tv.playback

import app.panda.tv.net.PublicNetwork
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InterruptedIOException
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

data class FirstSegment(
    val url: String,
    val keyUrl: String? = null,
    val iv: ByteArray? = null,
    val sealed: Boolean = false,
    val seconds: Double? = null,
)

data class WarmedEntry(
    val body: ByteArray,
    val type: String,
    val finalUrl: String,
    val expires: Long,
)

class SharedSegmentFlow(
    val type: String,
    val length: Long,
    private val onFinished: (ByteArray) -> Unit,
) {
    private val lock = ReentrantLock()
    private val cond = lock.newCondition()
    private val chunks = ArrayList<ByteArray>()
    private var totalWritten = 0L
    private var state = 0 // 0=active, 1=ended, 2=failed
    private var closedForMemory = false
    private var activeReaders = 0

    fun write(chunk: ByteArray, len: Int = chunk.size): Boolean {
        if (len <= 0) return true
        val copy = chunk.copyOf(len)
        lock.withLock {
            if (state != 0) return false
            totalWritten += len
            if (totalWritten > WARM_ITEM_BYTES) {
                closedForMemory = true
                if (activeReaders == 0) {
                    state = 2
                    chunks.clear()
                    cond.signalAll()
                    return false
                }
                if (totalWritten > SEGMENT_BYTES) {
                    state = 2
                    chunks.clear()
                    cond.signalAll()
                    return false
                }
            }
            chunks.add(copy)
            cond.signalAll()
            return true
        }
    }

    fun end() {
        var whole: ByteArray? = null
        lock.withLock {
            if (state != 0) return
            state = 1
            if (!closedForMemory && totalWritten <= WARM_ITEM_BYTES) {
                val out = ByteArrayOutputStream(totalWritten.toInt())
                for (c in chunks) out.write(c)
                whole = out.toByteArray()
            }
            if (activeReaders == 0) {
                chunks.clear()
                // A player can obtain the shared flow just before completion,
                // then attach after it has moved into the warm cache. Keep the
                // same completed array for that reader instead of returning EOF.
                whole?.takeIf { it.isNotEmpty() }?.let { chunks.add(it) }
            }
            cond.signalAll()
        }
        whole?.let { onFinished(it) }
    }

    fun fail() {
        lock.withLock {
            if (state != 0) return
            state = 2
            chunks.clear()
            cond.signalAll()
        }
    }

    fun openReader(): Reader = lock.withLock {
        activeReaders++
        Reader()
    }

    inner class Reader {
        private var chunkIndex = 0
        private var offsetInChunk = 0
        private var closed = false

        fun read(dest: ByteArray, destOffset: Int, destLen: Int): Int {
            if (destLen == 0) return 0
            lock.withLock {
                if (closed) return -1
                while (!closed && chunkIndex >= chunks.size && state == 0) {
                    try {
                        cond.await()
                    } catch (interrupted: InterruptedException) {
                        Thread.currentThread().interrupt()
                        throw InterruptedIOException("媒体分片读取中断").apply { initCause(interrupted) }
                    }
                }
                if (closed) return -1
                if (state == 2) {
                    throw IOException("媒体分片读取中断")
                }
                if (chunkIndex < chunks.size) {
                    val cur = chunks[chunkIndex]
                    val avail = cur.size - offsetInChunk
                    val count = minOf(destLen, avail)
                    System.arraycopy(cur, offsetInChunk, dest, destOffset, count)
                    offsetInChunk += count
                    if (offsetInChunk >= cur.size) {
                        chunkIndex++
                        offsetInChunk = 0
                    }
                    return count
                }
                return -1
            }
        }

        fun close() {
            lock.withLock {
                if (!closed) {
                    closed = true
                    if (activeReaders > 0) activeReaders--
                    if (activeReaders == 0 && (closedForMemory || state != 0)) {
                        if (state == 0) state = 2
                        chunks.clear()
                    }
                    cond.signalAll()
                }
            }
        }
    }

    companion object {
        const val WARM_ITEM_BYTES = 4 * 1024 * 1024L
        const val SEGMENT_BYTES = 48 * 1024 * 1024L
    }
}

class WarmMediaCache(
    private val rules: SourceRules,
    private val onDiagnostic: (String, FilterResult) -> Unit = { _, _ -> },
) {
    private val lock = Any()
    private val warmed = LinkedHashMap<String, WarmedEntry>(16, 0.75f, true)
    private var warmedBytes = 0L
    private val flows = HashMap<String, SharedSegmentFlow>()
    private val sourceMap = LinkedHashMap<String, Pair<PlaySource, Boolean>>(256, 0.75f, true)

    fun registerSource(url: String, source: PlaySource, preserveTimeline: Boolean) {
        val canonical = try { PublicNetwork.validatePublicUrl(url).toString() } catch (_: Exception) { url }
        synchronized(lock) {
            sourceMap[canonical] = source to preserveTimeline
            while (sourceMap.size > 40000) {
                val oldest = sourceMap.keys.firstOrNull() ?: break
                sourceMap.remove(oldest)
            }
        }
    }

    fun sourceFor(url: String): Pair<PlaySource, Boolean>? {
        val canonical = try { PublicNetwork.validatePublicUrl(url).toString() } catch (_: Exception) { url }
        return synchronized(lock) { sourceMap[canonical] ?: sourceMap[url] }
    }

    fun recordDiagnostic(sourceKey: String, result: FilterResult) {
        onDiagnostic(sourceKey, result)
    }

    fun warm(requestedUrl: String, finalUrl: String, body: ByteArray, type: String) {
        if (body.isEmpty() || body.size > SharedSegmentFlow.WARM_ITEM_BYTES) return
        val key = try { PublicNetwork.validatePublicUrl(requestedUrl).toString() } catch (_: Exception) { return }
        synchronized(lock) {
            forgetLocked(key)
            warmed[key] = WarmedEntry(body, type, finalUrl, System.currentTimeMillis() + WARM_MS)
            warmedBytes += body.size
            val now = System.currentTimeMillis()
            val iter = warmed.entries.iterator()
            while (iter.hasNext() && (warmedBytes > WARM_BYTES || now >= warmed.entries.first().value.expires)) {
                val e = iter.next()
                if (warmedBytes <= WARM_BYTES && e.value.expires > now) break
                warmedBytes -= e.value.body.size
                iter.remove()
            }
        }
    }

    fun getWarmed(url: String, evictIfLargeSegment: Boolean = false): WarmedEntry? {
        val key = try { PublicNetwork.validatePublicUrl(url).toString() } catch (_: Exception) { url }
        synchronized(lock) {
            val entry = warmed[key] ?: return null
            if (entry.expires <= System.currentTimeMillis()) {
                forgetLocked(key)
                return null
            }
            if (evictIfLargeSegment && entry.body.size > 65536) {
                forgetLocked(key)
            }
            return entry
        }
    }

    fun share(requestedUrl: String, finalUrl: String, type: String, length: Long): SharedSegmentFlow {
        val key = try { PublicNetwork.validatePublicUrl(requestedUrl).toString() } catch (_: Exception) { requestedUrl }
        lateinit var created: SharedSegmentFlow
        created = SharedSegmentFlow(type, length) { fullBytes ->
            synchronized(lock) {
                if (flows[key] === created) flows.remove(key)
            }
            warm(key, finalUrl, fullBytes, type)
        }
        synchronized(lock) {
            flows.remove(key)?.fail()
            flows[key] = created
        }
        return created
    }

    fun finishFlow(requestedUrl: String, flow: SharedSegmentFlow, success: Boolean) {
        val key = try { PublicNetwork.validatePublicUrl(requestedUrl).toString() } catch (_: Exception) { requestedUrl }
        synchronized(lock) {
            if (flows[key] === flow) flows.remove(key)
        }
        if (success) flow.end() else flow.fail()
    }

    fun getShared(url: String): SharedSegmentFlow? {
        val key = try { PublicNetwork.validatePublicUrl(url).toString() } catch (_: Exception) { url }
        return synchronized(lock) { flows[key] }
    }

    fun firstSegment(text: String, baseUrl: String, source: PlaySource, preserveTimeline: Boolean): FirstSegment? {
        val filtered = PlaylistFilter.filterPlaylist(
            text,
            baseUrl,
            source,
            rules,
            preserveTimeline || PlaylistFilter.hasSynchronizedTracks(text),
        ).text
        var keyLine: String? = null
        var sequence = 0L
        var seconds: Double? = null
        for (raw in filtered.split(Regex("\\r?\\n"))) {
            val line = raw.trim()
            when {
                line.startsWith("#EXT-X-MEDIA-SEQUENCE:") -> {
                    sequence = line.substring(22).trim().toLongOrNull() ?: 0L
                }
                line.startsWith("#EXT-X-KEY:") -> keyLine = line
                line.startsWith("#EXTINF:") -> seconds = line.substring(8).substringBefore(',').toDoubleOrNull()?.takeIf { it.isFinite() && it > 0.0 }
                line.isNotEmpty() && !line.startsWith("#") -> {
                    val segUrl = PublicNetwork.resolveUrl(baseUrl, line)
                    if (keyLine == null || keyLine.contains("METHOD=NONE")) {
                        return FirstSegment(segUrl, seconds = seconds)
                    }
                    val uri = Regex("""URI="([^"]+)"""").find(keyLine)?.groupValues?.get(1)
                    if (!Regex("METHOD=AES-128(?:,|$)").containsMatchIn(keyLine) || uri == null) {
                        return FirstSegment(segUrl, sealed = true, seconds = seconds)
                    }
                    val stated = Regex("IV=0x([0-9a-f]{1,32})", RegexOption.IGNORE_CASE).find(keyLine)?.groupValues?.get(1)
                    val iv = ByteArray(16)
                    if (stated != null) {
                        val padded = stated.padStart(32, '0')
                        for (i in 0 until 16) {
                            iv[i] = padded.substring(i * 2, i * 2 + 2).toInt(16).toByte()
                        }
                    } else {
                        val v = sequence and 0xffffffffL
                        iv[12] = ((v ushr 24) and 0xff).toByte()
                        iv[13] = ((v ushr 16) and 0xff).toByte()
                        iv[14] = ((v ushr 8) and 0xff).toByte()
                        iv[15] = (v and 0xff).toByte()
                    }
                    return FirstSegment(segUrl, keyUrl = PublicNetwork.resolveUrl(baseUrl, uri), iv = iv, seconds = seconds)
                }
            }
        }
        return null
    }

    private fun forgetLocked(key: String) {
        val removed = warmed.remove(key) ?: return
        warmedBytes -= removed.body.size
    }

    companion object {
        private const val WARM_MS = 3 * 60_000L
        private const val WARM_BYTES = 8 * 1024 * 1024L
    }
}
