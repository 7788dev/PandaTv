package app.panda.tv

import android.app.Application
import android.util.Log
import app.panda.tv.data.DoubanDataSource
import app.panda.tv.data.TitleSearchIndex
import app.panda.tv.image.ImageLoader
import app.panda.tv.net.TlsCompat
import app.panda.tv.playback.PlaybackService
import app.panda.tv.playback.SourceRules
import app.panda.tv.playback.SourceRulesLoader
import app.panda.tv.playback.WarmMediaCache
import app.panda.tv.state.UserStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import java.io.File

class PandaTvApp : Application() {
    lateinit var userStore: UserStore
        private set
    lateinit var douban: DoubanDataSource
        private set
    lateinit var sourceRules: SourceRules
        private set
    lateinit var warmCache: WarmMediaCache
        private set
    lateinit var playback: PlaybackService
        private set
    lateinit var images: ImageLoader
        private set

    val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    override fun onCreate() {
        super.onCreate()
        TlsCompat.installAsync(this)

        val metaDir = File(filesDir, "cache").apply { mkdirs() }
        userStore = UserStore(File(filesDir, "user-state.json"))
        douban = DoubanDataSource(cacheDir = metaDir, titleIndex = {
            val dictionary = assets.open("search-initials.json").bufferedReader(Charsets.UTF_8).use { it.readText() }
            val titles = assets.open("search-titles.tsv").bufferedReader(Charsets.UTF_8).use { it.readText() }
            TitleSearchIndex(dictionary, titles)
        }, onSearchDiagnostic = { event -> Log.i("PandaTV", "[search] $event") }) { w ->
            Log.w("PandaTV", "[douban] ${w.operation}: ${w.code} (${w.message})")
        }
        sourceRules = assets.open("play-sources.json").use { stream ->
            SourceRulesLoader.resolve(stream, File(filesDir, "play-sources.json")) { msg ->
                Log.i("PandaTV", "[rules] $msg")
            }
        }
        warmCache = WarmMediaCache(sourceRules) { src, res ->
            if (res.removedSegments > 0 || res.reason !in setOf("clean-or-unverified")) {
                Log.i("PandaTV", "[ad] $src: ${res.reason} (-${res.removedSegments} segs, ${res.removedSeconds}s, ${res.evidence})")
            }
        }
        playback = PlaybackService(sourceRules, warmCache) { src, reason, ms ->
            Log.i("PandaTV", "[source] $src (${ms}ms): $reason")
        }
        images = ImageLoader(this)
    }

    fun flushAll() {
        appScope.launch(Dispatchers.IO) {
            douban.flush()
        }
    }
}
