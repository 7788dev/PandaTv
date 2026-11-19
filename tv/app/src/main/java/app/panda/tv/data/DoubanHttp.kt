package app.panda.tv.data

import app.panda.tv.model.Json
import app.panda.tv.net.PublicNetwork
import app.panda.tv.net.PublicNetworkException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withLock
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.URI
import java.net.URL
import java.util.Locale
import javax.net.ssl.HttpsURLConnection
import kotlin.random.Random

enum class DataErrorCode {
    INVALID_INPUT,
    NOT_FOUND,
    NETWORK,
    TIMEOUT,
    RATE_LIMITED,
    UPSTREAM,
    INVALID_RESPONSE,
    UNAVAILABLE,
    STORAGE,
}

class DataError(
    val code: DataErrorCode,
    message: String,
    val retryable: Boolean = false,
) : RuntimeException(message)

data class DataWarning(
    val code: String,
    val operation: String,
    val message: String,
    val at: Long,
)

class HttpReply(
    val status: Int,
    val body: String,
    val retryAfterSeconds: Long? = null,
)

fun interface MetadataFetcher {
    suspend fun get(url: String, timeoutMs: Int): HttpReply
}

class DoubanHttp(
    private val fetcher: MetadataFetcher? = null,
    private val timeoutMs: Int = 8500,
    private val patientTimeoutMs: Int = 20000,
    private val intervalMs: Long = 180L,
    maxConcurrent: Int = 4,
    burst: Int = 4,
    private val retries: Int = 1,
    private val maxEntries: Int = 96,
    private val maxBytes: Int = 4 * 1024 * 1024,
) {
    private data class Cached(val value: Any?, val expires: Long, val bytes: Int)

    private val semaphore = Semaphore(maxConcurrent)
    private val lock = Any()
    private val cache = LinkedHashMap<String, Cached>(32, 0.75f, true)
    private var totalBytes = 0
    private val flights = HashMap<String, CompletableDeferred<Any?>>()
    private val paceMutex = Mutex()
    private var nextStart = 0L
    private val burstCount = maxOf(1, burst)

    suspend fun <T> json(
        url: String,
        ttlMs: Long,
        validate: (Any?) -> T,
        patient: Boolean = false,
    ): T {
        val uri = try {
            URI(url)
        } catch (_: Exception) {
            throw DataError(DataErrorCode.INVALID_INPUT, "Unapproved metadata origin")
        }
        val host = uri.host?.lowercase(Locale.US)
        if (uri.scheme != "https" || host !in ALLOWED_HOSTS || !uri.userInfo.isNullOrEmpty()) {
            throw DataError(DataErrorCode.INVALID_INPUT, "Unapproved metadata origin")
        }

        val now = System.currentTimeMillis()
        synchronized(lock) {
            val cached = cache[url]
            if (cached != null && cached.expires > now) {
                return validate(cached.value)
            }
            if (cached != null) removeLocked(url)
        }

        var existing: CompletableDeferred<Any?>?
        var created: CompletableDeferred<Any?>? = null
        synchronized(lock) {
            existing = flights[url]
            if (existing == null) {
                created = CompletableDeferred()
                flights[url] = created!!
            }
        }
        if (existing != null) {
            return validate(existing!!.await())
        }

        val deferred = created!!
        return try {
            val (value, bytes) = request(url, patient)
            val validated = validate(value)
            if (bytes <= maxBytes && ttlMs > 0L) {
                synchronized(lock) {
                    removeLocked(url)
                    cache[url] = Cached(value, System.currentTimeMillis() + ttlMs, bytes)
                    totalBytes += bytes
                    while (cache.size > maxEntries || totalBytes > maxBytes) {
                        val oldest = cache.keys.firstOrNull() ?: break
                        removeLocked(oldest)
                    }
                }
            }
            deferred.complete(value)
            validated
        } catch (t: Throwable) {
            deferred.completeExceptionally(t)
            throw t
        } finally {
            synchronized(lock) {
                if (flights[url] === deferred) flights.remove(url)
            }
        }
    }

    fun clear() {
        synchronized(lock) {
            cache.clear()
            totalBytes = 0
        }
    }

    private fun removeLocked(key: String) {
        val removed = cache.remove(key) ?: return
        totalBytes -= removed.bytes
    }

    private suspend fun acquirePace() {
        val waitMs = paceMutex.withLock {
            val now = System.currentTimeMillis()
            val start = maxOf(now, nextStart - (burstCount - 1) * intervalMs)
            nextStart = maxOf(now, nextStart) + intervalMs
            maxOf(0L, start - now)
        }
        if (waitMs > 0L) delay(waitMs)
    }

    private suspend fun request(initialUrl: String, patient: Boolean): Pair<Any?, Int> {
        var last = DataError(DataErrorCode.NETWORK, "Metadata request failed", retryable = true)
        val effectiveTimeout = if (patient) patientTimeoutMs else timeoutMs

        for (attempt in 0..retries) {
            semaphore.acquire()
            var retryDelay = 250L + Random.nextInt(200)
            try {
                acquirePace()
                val reply = fetchWithRedirects(initialUrl, effectiveTimeout)
                if (reply.status !in 200..299) {
                    reply.retryAfterSeconds?.takeIf { it > 0L }?.let {
                        retryDelay = minOf(2000L, it * 1000L)
                    }
                    val code = when (reply.status) {
                        429 -> DataErrorCode.RATE_LIMITED
                        404 -> DataErrorCode.NOT_FOUND
                        else -> DataErrorCode.UPSTREAM
                    }
                    throw DataError(code, "Metadata HTTP ${reply.status}", reply.status == 429 || reply.status >= 500)
                }
                val parsed = try {
                    Json.parse(reply.body)
                } catch (_: Exception) {
                    throw DataError(DataErrorCode.INVALID_RESPONSE, "Metadata returned invalid JSON")
                }
                if (parsed !is Map<*, *> && parsed !is List<*>) {
                    throw DataError(DataErrorCode.INVALID_RESPONSE, "Metadata returned invalid JSON")
                }
                return parsed to (reply.body.length * 2).coerceAtLeast(64)
            } catch (e: DataError) {
                last = e
            } catch (e: Exception) {
                val timedOut = e is java.net.SocketTimeoutException ||
                    e.message?.contains("timed out", ignoreCase = true) == true
                last = DataError(
                    if (timedOut) DataErrorCode.TIMEOUT else DataErrorCode.NETWORK,
                    if (timedOut) "Metadata request timed out" else "Metadata network unavailable",
                    retryable = true,
                )
            } finally {
                semaphore.release()
            }
            if (!last.retryable || attempt == retries || (patient && last.code == DataErrorCode.TIMEOUT)) {
                throw last
            }
            delay(retryDelay)
        }
        throw last
    }

    private suspend fun fetchWithRedirects(initialUrl: String, timeoutMs: Int): HttpReply {
        if (fetcher != null) return fetcher.get(initialUrl, timeoutMs)
        return kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
            var current = URI(initialUrl)
            var redirect = 0
            while (true) {
                val host = current.host?.lowercase(Locale.US) ?: ""
                if (current.scheme != "https" || host !in ALLOWED_HOSTS || !current.userInfo.isNullOrEmpty()) {
                    throw DataError(DataErrorCode.UPSTREAM, "Metadata redirect rejected")
                }
                val resolved = InetAddress.getAllByName(host)
                if (resolved.isEmpty() || resolved.any { !PublicNetwork.isPublicAddress(it.hostAddress ?: "", allowFakeIp = true) }) {
                    throw DataError(DataErrorCode.NETWORK, "Metadata host blocked")
                }
                val conn = (URL(current.toString()).openConnection() as HttpsURLConnection).apply {
                    app.panda.tv.net.TlsCompat.currentSocketFactory()?.let { sslSocketFactory = it }
                    requestMethod = "GET"
                    instanceFollowRedirects = false
                    connectTimeout = timeoutMs
                    readTimeout = timeoutMs
                    setRequestProperty("User-Agent", PublicNetwork.USER_AGENT)
                    setRequestProperty("Referer", "https://$host/")
                    setRequestProperty("Accept", "application/json")
                    setRequestProperty("Accept-Encoding", "identity")
                }
                try {
                    val status = conn.responseCode
                    if (status in listOf(301, 302, 303, 307, 308)) {
                        val location = conn.getHeaderField("Location")
                        conn.disconnect()
                        if (location.isNullOrBlank()) {
                            throw DataError(DataErrorCode.INVALID_RESPONSE, "Missing redirect target")
                        }
                        if (redirect >= 3) {
                            throw DataError(DataErrorCode.UPSTREAM, "Metadata redirect rejected")
                        }
                        current = current.resolve(location)
                        redirect++
                        continue
                    }
                    val len = conn.getHeaderField("Content-Length")?.trim()?.toLongOrNull() ?: -1L
                    if (len > MAX_BODY) {
                        throw DataError(DataErrorCode.INVALID_RESPONSE, "Metadata body too large")
                    }
                    val stream = if (status in 200..299) conn.inputStream else (conn.errorStream ?: conn.inputStream)
                    val bodyBytes = try {
                        PublicNetwork.readLimited(stream, len, MAX_BODY)
                    } catch (_: PublicNetworkException) {
                        throw DataError(DataErrorCode.INVALID_RESPONSE, "Metadata body too large")
                    }
                    val retryAfter = conn.getHeaderField("Retry-After")?.trim()?.toLongOrNull()
                    return@withContext HttpReply(status, bodyBytes.toString(Charsets.UTF_8), retryAfter)
                } finally {
                    conn.disconnect()
                }
            }
            @Suppress("UNREACHABLE_CODE")
            throw DataError(DataErrorCode.NETWORK, "Metadata response missing", true)
        }
    }

    companion object {
        private const val MAX_BODY = 8 * 1024 * 1024
        private val ALLOWED_HOSTS = setOf("m.douban.com", "movie.douban.com", "top.baidu.com")
    }
}
