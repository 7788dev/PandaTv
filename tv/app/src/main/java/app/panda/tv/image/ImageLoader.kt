package app.panda.tv.image

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Shader
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.LruCache
import android.view.animation.DecelerateInterpolator
import android.widget.ImageView
import app.panda.tv.R
import app.panda.tv.data.Normalize
import app.panda.tv.net.PublicNetwork
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.withContext
import java.io.File
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger
import kotlin.coroutines.coroutineContext

class ImageLoader(context: Context) {
    private val cacheDir = File(context.cacheDir, "images").apply { mkdirs() }
    private val mainHandler = Handler(Looper.getMainLooper())
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val netSemaphore = Semaphore(6)
    /** Cap concurrent Bitmap decodes so 4-core Cortex-A53 TVs keep UI & RenderThread at 60fps while scrolling. */
    private val decodeSemaphore = Semaphore(3)
    private val flights = HashMap<String, CompletableDeferred<ByteArray?>>()
    private val diskWriteLock = Any()
    private val writeCounter = AtomicInteger(0)

    private val decodeBuffers = object : ThreadLocal<ByteArray>() {
        override fun initialValue(): ByteArray = ByteArray(16 * 1024)
    }

    private val memCache: LruCache<String, Bitmap> = run {
        val maxKb = (Runtime.getRuntime().maxMemory() / 1024L).toInt()
        val budgetKb = minOf(maxKb / 8, 20 * 1024).coerceAtLeast(4096)
        object : LruCache<String, Bitmap>(budgetKb) {
            override fun sizeOf(key: String, value: Bitmap): Int =
                (value.byteCount / 1024).coerceAtLeast(1)
        }
    }

    fun clear(view: ImageView) {
        (view.getTag(R.id.tag_image_job) as? Job)?.cancel()
        view.setTag(R.id.tag_image_job, null)
        view.setTag(R.id.tag_image_key, null)
        view.animate().cancel()
        view.alpha = 1f
        view.setImageBitmap(null)
    }

    fun cancelPending(view: ImageView) {
        (view.getTag(R.id.tag_image_job) as? Job)?.cancel()
        view.setTag(R.id.tag_image_job, null)
        if (view.drawable == null) view.setTag(R.id.tag_image_key, null)
        view.animate().cancel()
        view.alpha = 1f
    }

    fun load(
        view: ImageView,
        rawUrl: String?,
        reqWidth: Int,
        reqHeight: Int,
        circleTopCrop: Boolean = false,
        onResult: ((Boolean) -> Unit)? = null,
    ) {
        val validUrl = Normalize.imageUrl(rawUrl)?.let { u ->
            if (u.startsWith("http://")) "https://${u.substring(7)}" else u
        }
        if (validUrl == null) {
            clear(view)
            onResult?.invoke(false)
            return
        }
        val safeW = reqWidth.coerceAtLeast(32)
        val safeH = reqHeight.coerceAtLeast(32)
        val key = "$validUrl|${safeW}x$safeH|$circleTopCrop"
        val prevKey = view.getTag(R.id.tag_image_key) as? String
        if (prevKey == key) {
            if (view.drawable != null) {
                onResult?.invoke(true)
                return
            }
            if ((view.getTag(R.id.tag_image_job) as? Job)?.isActive == true) return
        }

        (view.getTag(R.id.tag_image_job) as? Job)?.cancel()
        view.setTag(R.id.tag_image_key, key)

        memCache.get(key)?.let { cached ->
            view.setTag(R.id.tag_image_job, null)
            view.animate().cancel()
            view.alpha = 1f
            view.setImageBitmap(cached)
            onResult?.invoke(true)
            return
        }

        view.animate().cancel()
        view.alpha = 1f
        view.setImageBitmap(null)
        val startedAt = SystemClock.uptimeMillis()

        val job = scope.launch {
            try {
                val bytes = fetchBytes(validUrl)
                coroutineContext.ensureActive()
                val bitmap = if (bytes != null) {
                    decodeSemaphore.acquire()
                    try {
                        coroutineContext.ensureActive()
                        decodeBitmap(bytes, safeW, safeH, circleTopCrop)
                    } finally {
                        decodeSemaphore.release()
                    }
                } else {
                    null
                }
                if (bitmap != null) {
                    memCache.put(key, bitmap)
                }
                coroutineContext.ensureActive()
                mainHandler.post {
                    if (view.getTag(R.id.tag_image_key) == key) {
                        view.setTag(R.id.tag_image_job, null)
                        if (bitmap != null) {
                            val elapsed = SystemClock.uptimeMillis() - startedAt
                            view.setImageBitmap(bitmap)
                            if (elapsed >= 32L) {
                                view.alpha = 0f
                                view.animate()
                                    .alpha(1f)
                                    .setDuration(110L)
                                    .setInterpolator(FADE_INTERPOLATOR)
                                    .start()
                            } else {
                                view.alpha = 1f
                            }
                        }
                        onResult?.invoke(bitmap != null)
                    }
                }
            } catch (ce: CancellationException) {
                throw ce
            } catch (_: Throwable) {
                mainHandler.post {
                    if (view.getTag(R.id.tag_image_key) == key) {
                        view.setTag(R.id.tag_image_job, null)
                        onResult?.invoke(false)
                    }
                }
            }
        }
        view.setTag(R.id.tag_image_job, job)
    }

    private suspend fun fetchBytes(url: String): ByteArray? {
        val diskFile = File(cacheDir, sha256(url))
        if (diskFile.exists() && diskFile.length() > 0L) {
            val cachedBytes = runCatching { diskFile.readBytes() }.getOrNull()
            if (cachedBytes != null && cachedBytes.isNotEmpty()) {
                val now = System.currentTimeMillis()
                if (now - diskFile.lastModified() > TOUCH_INTERVAL_MS) {
                    diskFile.setLastModified(now)
                }
                return cachedBytes
            }
        }

        var existing: CompletableDeferred<ByteArray?>?
        var created: CompletableDeferred<ByteArray?>? = null
        synchronized(flights) {
            existing = flights[url]
            if (existing == null) {
                created = CompletableDeferred()
                flights[url] = created!!
            }
        }
        if (existing != null) return existing!!.await()
        val deferred = created!!
        return try {
            val bytes = downloadWithRetries(url)
            if (bytes != null && bytes.isNotEmpty()) {
                writeDisk(diskFile, bytes)
            }
            deferred.complete(bytes)
            bytes
        } catch (_: Throwable) {
            deferred.complete(null)
            null
        } finally {
            synchronized(flights) {
                if (flights[url] === deferred) flights.remove(url)
            }
        }
    }

    private suspend fun downloadWithRetries(url: String): ByteArray? = withContext(Dispatchers.IO) {
        netSemaphore.acquire()
        try {
            for ((connectMs, readMs) in ATTEMPTS) {
                coroutineContext.ensureActive()
                try {
                    val resp = PublicNetwork.openPublic(
                        rawUrl = url,
                        headers = mapOf(
                            "Referer" to "https://movie.douban.com/",
                            "Accept" to "image/webp,image/jpeg,image/png,*/*",
                        ),
                        connectTimeoutMs = connectMs,
                        readTimeoutMs = readMs,
                    )
                    try {
                        if (resp.statusCode !in 200..299) continue
                        val finalNorm = Normalize.imageUrl(resp.finalUrl)
                        if (finalNorm == null || !finalNorm.startsWith("https://")) return@withContext null
                        val ctype = resp.contentType.lowercase(java.util.Locale.US)
                        if (!ctype.startsWith("image/") || ctype.contains("avif")) return@withContext null
                        val bytes = PublicNetwork.readLimited(resp.stream, resp.contentLength, 12 * 1024 * 1024)
                        if (resp.contentLength > 0L && resp.contentLength != bytes.size.toLong()) continue
                        return@withContext bytes
                    } finally {
                        resp.close()
                    }
                } catch (ce: CancellationException) {
                    throw ce
                } catch (_: Exception) {
                }
            }
            null
        } finally {
            netSemaphore.release()
        }
    }

    private fun writeDisk(target: File, bytes: ByteArray) {
        synchronized(diskWriteLock) {
            try {
                cacheDir.mkdirs()
                val tmp = File(cacheDir, "${target.name}.${UUID.randomUUID()}.tmp")
                tmp.writeBytes(bytes)
                if (!tmp.renameTo(target)) {
                    target.writeBytes(bytes)
                    tmp.delete()
                }
                val count = writeCounter.incrementAndGet()
                if (count == 1 || count % PRUNE_EVERY_WRITES == 0) {
                    pruneDiskLocked()
                }
            } catch (_: Exception) {
            }
        }
    }

    private fun pruneDiskLocked() {
        val files = cacheDir.listFiles() ?: return
        var total = 0L
        for (f in files) total += f.length()
        if (total <= MAX_DISK_BYTES) return
        val sorted = files.sortedBy { it.lastModified() }
        for (f in sorted) {
            if (total <= MAX_DISK_BYTES * 3L / 4L) break
            val len = f.length()
            if (f.delete()) total -= len
        }
    }

    private fun decodeBitmap(bytes: ByteArray, reqW: Int, reqH: Int, circleTopCrop: Boolean): Bitmap? {
        val tempBuf = decodeBuffers.get()
        val bounds = BitmapFactory.Options().apply {
            inJustDecodeBounds = true
            inTempStorage = tempBuf
        }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null

        val opts = BitmapFactory.Options().apply {
            inSampleSize = calcSampleSize(bounds.outWidth, bounds.outHeight, reqW, reqH)
            inPreferredConfig = if (circleTopCrop) Bitmap.Config.ARGB_8888 else Bitmap.Config.RGB_565
            inTempStorage = tempBuf
        }
        val decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts) ?: return null
        if (!circleTopCrop) return decoded

        val size = minOf(reqW, reqH).coerceAtLeast(64)
        val out = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(out)
        val shader = BitmapShader(decoded, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP)
        val scale = maxOf(size.toFloat() / decoded.width, size.toFloat() / decoded.height)
        val dx = (size - decoded.width * scale) / 2f
        val matrix = Matrix().apply {
            setScale(scale, scale)
            postTranslate(dx, 0f) // Top-aligned (50% 0): keeps heads intact for portrait photos
        }
        shader.setLocalMatrix(matrix)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { this.shader = shader }
        val r = size / 2f
        canvas.drawCircle(r, r, r, paint)
        val ringPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.STROKE
            strokeWidth = 2f
            color = 0x1AEFEAE2
        }
        canvas.drawCircle(r, r, r - 1f, ringPaint)
        decoded.recycle()
        return out
    }

    private fun calcSampleSize(w: Int, h: Int, reqW: Int, reqH: Int): Int {
        var sample = 1
        if (h > reqH || w > reqW) {
            val halfH = h / 2
            val halfW = w / 2
            while (halfH / sample >= reqH && halfW / sample >= reqW) sample *= 2
        }
        return sample
    }

    private fun sha256(s: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(s.toByteArray(Charsets.UTF_8))
        val sb = StringBuilder(digest.size * 2)
        for (b in digest) {
            val v = b.toInt() and 0xff
            sb.append(HEX[v ushr 4]).append(HEX[v and 0x0f])
        }
        return sb.toString()
    }

    companion object {
        private const val HEX = "0123456789abcdef"
        private val ATTEMPTS = listOf(1500 to 3500, 2500 to 5500, 5000 to 9000)
        private const val MAX_DISK_BYTES = 36L * 1024L * 1024L
        private const val TOUCH_INTERVAL_MS = 15 * 60_000L
        private const val PRUNE_EVERY_WRITES = 24
        private val FADE_INTERPOLATOR = DecelerateInterpolator(1.6f)
    }
}
