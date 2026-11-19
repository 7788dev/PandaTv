package app.panda.tv.net

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.URI
import java.net.URL
import java.util.Locale
import javax.net.ssl.HttpsURLConnection

class PublicNetworkException(message: String, cause: Throwable? = null) : IOException(message, cause)

data class PublicResponse(
    val statusCode: Int,
    val finalUrl: String,
    val contentType: String,
    val contentLength: Long,
    val contentRange: String?,
    val acceptRanges: String?,
    val stream: InputStream,
    private val connection: HttpURLConnection,
) {
    fun close() {
        try {
            stream.close()
        } catch (_: Exception) {
        }
        try {
            connection.disconnect()
        } catch (_: Exception) {
        }
    }
}

object PublicNetwork {
    const val NOT_PUBLIC = "已拒绝非公开网络地址"
    const val USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36"

    private val BAD_PORTS = setOf(
        1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95,
        101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179,
        389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601,
        636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566,
        6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
    )

    private val LOCAL_HOST_SUFFIX = Regex("(?:^|\\.)(?:localhost|local|internal|test|invalid)$")
    private val IPV4_REGEX = Regex("^(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})$")

    fun allowedPort(port: Int): Boolean = port in 1..65535 && port !in BAD_PORTS

    fun unreachableHere(error: Throwable?): Boolean {
        var cur = error
        var depth = 0
        while (cur != null && depth < 12) {
            if (cur.message == NOT_PUBLIC) return true
            cur = cur.cause
            depth++
        }
        return false
    }

    fun isIpLiteral(host: String): Boolean {
        val clean = host.lowercase(Locale.US).trimStart('[').trimEnd(']')
        return parseIpv4(clean) != null || clean.contains(':')
    }

    fun isPublicAddress(raw: String, allowFakeIp: Boolean = false): Boolean {
        val ip = raw.lowercase(Locale.US).trimStart('[').trimEnd(']')
        if (ip.startsWith("::ffff:")) return isPublicAddress(ip.substring(7), allowFakeIp)
        val v4 = parseIpv4(ip)
        if (v4 != null) {
            val a = v4[0]
            val b = v4[1]
            if (a == 0 || a == 10 || a == 127 || a >= 224) return false
            if (a == 169 && b == 254) return false
            if (a == 172 && b in 16..31) return false
            if (a == 192 && b == 168) return false
            if (a == 100 && b in 64..127) return false
            if (!allowFakeIp && a == 198 && (b == 18 || b == 19)) return false
            return true
        }
        if (!ip.contains(':')) return false
        val words = parseIpv6(ip) ?: return false
        val isZero = words.all { it == 0 }
        val isLoopback = words.dropLast(1).all { it == 0 } && words.last() == 1
        if (isZero || isLoopback) return false
        val first = words[0]
        if ((first and 0xfe00) == 0xfc00) return false // fc00::/7
        if ((first and 0xffc0) == 0xfe80) return false // fe80::/10
        if ((first and 0xff00) == 0xff00) return false // ff00::/8
        if (first == 0x2001 && words[1] == 0x0db8) return false // 2001:db8::/32
        return true
    }

    fun validatePublicUrl(raw: String): URI {
        val uri = try {
            URI(raw.trim())
        } catch (e: Exception) {
            throw PublicNetworkException("不支持的播放地址", e)
        }
        val scheme = uri.scheme?.lowercase(Locale.US)
        if ((scheme != "http" && scheme != "https") || !uri.userInfo.isNullOrEmpty()) {
            throw PublicNetworkException("不支持的播放地址")
        }
        val rawHost = uri.host ?: throw PublicNetworkException(NOT_PUBLIC)
        val host = rawHost.lowercase(Locale.US).trimEnd('.').trimStart('[').trimEnd(']')
        if (host.isEmpty() || LOCAL_HOST_SUFFIX.containsMatchIn(host)) {
            throw PublicNetworkException(NOT_PUBLIC)
        }
        if (isIpLiteral(host) && !isPublicAddress(host, allowFakeIp = false)) {
            throw PublicNetworkException(NOT_PUBLIC)
        }
        if (uri.port != -1 && !allowedPort(uri.port)) {
            throw PublicNetworkException("已拒绝非标准网络端口")
        }
        return uri
    }

    fun resolveUrl(base: String, location: String): String {
        val clean = location.trim()
        val withScheme = if (clean.startsWith("//")) {
            val baseScheme = try { URI(base).scheme ?: "https" } catch (_: Exception) { "https" }
            "$baseScheme:$clean"
        } else clean
        return URI(base).resolve(withScheme).toString()
    }

    fun originOf(uri: URI): String {
        val scheme = uri.scheme?.lowercase(Locale.US) ?: "https"
        val portPart = if (uri.port != -1) ":${uri.port}" else ""
        return "$scheme://${uri.host}$portPart"
    }

    fun openPublic(
        rawUrl: String,
        method: String = "GET",
        headers: Map<String, String> = emptyMap(),
        connectTimeoutMs: Int = 8000,
        readTimeoutMs: Int = 12000,
        depth: Int = 0,
    ): PublicResponse {
        val uri = validatePublicUrl(rawUrl)
        if (depth > 5) throw PublicNetworkException("网络重定向次数过多")
        val host = uri.host.trimStart('[').trimEnd(']')
        if (!isIpLiteral(host)) {
            val resolved = try {
                InetAddress.getAllByName(host)
            } catch (e: Exception) {
                throw PublicNetworkException("网络请求失败或超时", e)
            }
            if (resolved.isEmpty() || resolved.any { !isPublicAddress(it.hostAddress ?: "", allowFakeIp = true) }) {
                throw PublicNetworkException(NOT_PUBLIC)
            }
        }
        val conn = (URL(uri.toString()).openConnection() as HttpURLConnection).apply {
            if (this is HttpsURLConnection) {
                TlsCompat.currentSocketFactory()?.let { sslSocketFactory = it }
            }
            requestMethod = method
            instanceFollowRedirects = false
            connectTimeout = connectTimeoutMs
            readTimeout = readTimeoutMs
            setRequestProperty("User-Agent", USER_AGENT)
            setRequestProperty("Accept", "*/*")
            setRequestProperty("Accept-Encoding", "identity")
            setRequestProperty("Referer", "${originOf(uri)}/")
            for ((k, v) in headers) {
                setRequestProperty(k, v)
            }
        }
        val status = try {
            conn.responseCode
        } catch (e: Exception) {
            conn.disconnect()
            val msg = if (e.message?.contains("timed out", ignoreCase = true) == true) "片源响应超时" else "网络请求失败或超时"
            throw PublicNetworkException(msg, e)
        }
        if (status in listOf(301, 302, 303, 307, 308)) {
            val location = conn.getHeaderField("Location")
            conn.disconnect()
            if (!location.isNullOrBlank()) {
                val next = resolveUrl(uri.toString(), location)
                return openPublic(next, method, headers, connectTimeoutMs, readTimeoutMs, depth + 1)
            }
        }
        val stream = try {
            if (status in 200..399) conn.inputStream else (conn.errorStream ?: conn.inputStream)
        } catch (_: Exception) {
            conn.errorStream ?: ByteArrayInputStreamEmpty
        }
        val len = conn.getHeaderField("Content-Length")?.trim()?.toLongOrNull() ?: -1L
        return PublicResponse(
            statusCode = status,
            finalUrl = uri.toString(),
            contentType = conn.contentType ?: "",
            contentLength = len,
            contentRange = conn.getHeaderField("Content-Range"),
            acceptRanges = conn.getHeaderField("Accept-Ranges"),
            stream = stream,
            connection = conn,
        )
    }

    fun readLimited(stream: InputStream, declaredLength: Long, limitBytes: Int): ByteArray {
        if (declaredLength > limitBytes) throw PublicNetworkException("上游响应过大")
        val out = ByteArrayOutputStream(if (declaredLength > 0 && declaredLength < 262144) declaredLength.toInt() else 8192)
        val buf = ByteArray(16384)
        var total = 0
        while (true) {
            val read = stream.read(buf)
            if (read <= 0) break
            total += read
            if (total > limitBytes) throw PublicNetworkException("上游响应过大")
            out.write(buf, 0, read)
        }
        return out.toByteArray()
    }

    fun getText(
        rawUrl: String,
        headers: Map<String, String> = emptyMap(),
        connectTimeoutMs: Int = 8000,
        readTimeoutMs: Int = 12000,
        limitBytes: Int = 4 * 1024 * 1024,
    ): Pair<String, String> {
        val resp = openPublic(rawUrl, "GET", headers, connectTimeoutMs, readTimeoutMs)
        try {
            if (resp.statusCode !in 200..299) {
                throw PublicNetworkException("上游服务暂不可用（${resp.statusCode}）")
            }
            val bytes = readLimited(resp.stream, resp.contentLength, limitBytes)
            val text = bytes.toString(Charsets.UTF_8).let {
                if (it.isNotEmpty() && it[0] == '\uFEFF') it.substring(1) else it
            }
            return text to resp.finalUrl
        } finally {
            resp.close()
        }
    }

    private fun parseIpv4(ip: String): IntArray? {
        val m = IPV4_REGEX.matchEntire(ip) ?: return null
        val out = IntArray(4)
        for (i in 0..3) {
            val v = m.groupValues[i + 1].toIntOrNull() ?: return null
            if (v !in 0..255) return null
            out[i] = v
        }
        return out
    }

    private fun parseIpv6(ip: String): IntArray? {
        val parts = ip.split("::")
        if (parts.size > 2) return null
        val left = if (parts[0].isEmpty()) emptyList() else parts[0].split(":")
        val rightRaw = if (parts.size == 2 && parts[1].isNotEmpty()) parts[1].split(":") else emptyList()
        val right = ArrayList<String>()
        for (idx in rightRaw.indices) {
            val tok = rightRaw[idx]
            if (idx == rightRaw.lastIndex && tok.contains('.')) {
                val v4 = parseIpv4(tok) ?: return null
                right.add(((v4[0] shl 8) or v4[1]).toString(16))
                right.add(((v4[2] shl 8) or v4[3]).toString(16))
            } else {
                right.add(tok)
            }
        }
        val fill = 8 - (left.size + right.size)
        if ((parts.size == 1 && fill != 0) || (parts.size == 2 && fill < 1)) return null
        val hexGroups = ArrayList<String>(8).apply {
            addAll(left)
            repeat(fill) { add("0") }
            addAll(right)
        }
        if (hexGroups.size != 8) return null
        val words = IntArray(8)
        for (i in 0..7) {
            val g = hexGroups[i]
            if (g.isEmpty() || g.length > 4) return null
            words[i] = g.toIntOrNull(16) ?: return null
        }
        return words
    }

    private object ByteArrayInputStreamEmpty : InputStream() {
        override fun read(): Int = -1
    }
}
