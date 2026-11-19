package app.panda.tv.net

import android.content.Context
import java.io.ByteArrayInputStream
import java.io.InputStream
import java.net.InetAddress
import java.net.Socket
import java.security.KeyStore
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

/**
 * Bundles current Mozilla root CAs alongside the system TrustStore and enforces TLS 1.2+
 * in-place on Android 5.1 (API 22), returning the Conscrypt socket unwrapped so SNI stays intact.
 */
object TlsCompat {
    @Volatile
    var socketFactory: SSLSocketFactory? = null
        private set

    private val initLock = Any()
    private var initLatch: java.util.concurrent.CountDownLatch? = null

    fun installAsync(context: Context) {
        val appCtx = context.applicationContext
        val latch: java.util.concurrent.CountDownLatch
        synchronized(initLock) {
            if (socketFactory != null || initLatch != null) return
            latch = java.util.concurrent.CountDownLatch(1)
            initLatch = latch
        }
        Thread({
            try {
                install(appCtx)
            } finally {
                latch.countDown()
            }
        }, "panda-tls-init").start()
    }

    fun install(context: Context) {
        if (socketFactory != null) return
        synchronized(initLock) {
            if (socketFactory != null) return
            val factory = context.assets.open("cacerts.pem").use { stream ->
                createSocketFactory(stream).first
            }
            socketFactory = factory
            HttpsURLConnection.setDefaultSSLSocketFactory(factory)
        }
    }

    fun currentSocketFactory(): SSLSocketFactory? {
        socketFactory?.let { return it }
        val latch = synchronized(initLock) { initLatch }
        if (latch != null && Thread.currentThread().name != "main") {
            try {
                latch.await(5, java.util.concurrent.TimeUnit.SECONDS)
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
            }
        }
        return socketFactory
    }

    fun createSocketFactory(pemStream: InputStream): Pair<SSLSocketFactory, Int> {
        val (trustManager, count) = buildCompositeTrustManager(pemStream)
        val ctx = SSLContext.getInstance("TLS")
        ctx.init(null, arrayOf(trustManager), null)
        return ModernTlsSocketFactory(ctx.socketFactory) to count
    }

    fun buildCompositeTrustManager(pemStream: InputStream): Pair<X509TrustManager, Int> {
        val cf = CertificateFactory.getInstance("X.509")
        val bundledStore = KeyStore.getInstance(KeyStore.getDefaultType()).apply { load(null, null) }
        val pemText = pemStream.bufferedReader(Charsets.UTF_8).readText()
        val regex = Regex("-----BEGIN CERTIFICATE-----[\\s\\S]*?-----END CERTIFICATE-----")
        var count = 0
        for (match in regex.findAll(pemText)) {
            val cert = cf.generateCertificate(ByteArrayInputStream(match.value.toByteArray(Charsets.US_ASCII)))
            bundledStore.setCertificateEntry("mozilla-$count", cert)
            count++
        }
        val bundledTmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply {
            init(bundledStore)
        }
        val systemTmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply {
            init(null as KeyStore?)
        }
        val bundledTm = bundledTmf.trustManagers.filterIsInstance<X509TrustManager>().first()
        val systemTm = systemTmf.trustManagers.filterIsInstance<X509TrustManager>().first()
        val combinedIssuers = (bundledTm.acceptedIssuers.toList() + systemTm.acceptedIssuers.toList()).toTypedArray()

        val composite = object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<out X509Certificate>, authType: String) {
                systemTm.checkClientTrusted(chain, authType)
            }

            override fun checkServerTrusted(chain: Array<out X509Certificate>, authType: String) {
                try {
                    bundledTm.checkServerTrusted(chain, authType)
                    return
                } catch (firstErr: Exception) {
                    if (chain.size > 1) {
                        for (len in chain.size - 1 downTo 1) {
                            try {
                                bundledTm.checkServerTrusted(chain.copyOf(len), authType)
                                return
                            } catch (_: Exception) {
                            }
                        }
                    }
                    try {
                        systemTm.checkServerTrusted(chain, authType)
                    } catch (_: Exception) {
                        throw firstErr
                    }
                }
            }

            override fun getAcceptedIssuers(): Array<X509Certificate> = combinedIssuers
        }
        return composite to count
    }

    private class ModernTlsSocketFactory(private val delegate: SSLSocketFactory) : SSLSocketFactory() {
        private val preferred = setOf("TLSv1.3", "TLSv1.2", "TLSv1.1", "TLSv1")

        private fun configure(socket: Socket): Socket {
            if (socket is SSLSocket) {
                val enabled = socket.supportedProtocols.filter { it in preferred }.toTypedArray()
                if (enabled.isNotEmpty()) socket.enabledProtocols = enabled
            }
            return socket
        }

        override fun getDefaultCipherSuites(): Array<String> = delegate.defaultCipherSuites
        override fun getSupportedCipherSuites(): Array<String> = delegate.supportedCipherSuites
        override fun createSocket(s: Socket, host: String, port: Int, autoClose: Boolean): Socket =
            configure(delegate.createSocket(s, host, port, autoClose))
        override fun createSocket(host: String, port: Int): Socket =
            configure(delegate.createSocket(host, port))
        override fun createSocket(host: String, port: Int, localHost: InetAddress, localPort: Int): Socket =
            configure(delegate.createSocket(host, port, localHost, localPort))
        override fun createSocket(host: InetAddress, port: Int): Socket =
            configure(delegate.createSocket(host, port))
        override fun createSocket(address: InetAddress, port: Int, localAddress: InetAddress, localPort: Int): Socket =
            configure(delegate.createSocket(address, port, localAddress, localPort))
    }
}
