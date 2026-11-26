package app.panda.tv

import android.app.Application
import android.util.Log
import app.panda.tv.data.DoubanDataSource
import app.panda.tv.data.TitleSearchIndex
import app.panda.tv.image.ImageLoader
import app.panda.tv.net.TlsCompat
import app.panda.tv.playback.PlaybackService
import app.panda.tv.playback.RuleCalibration
import app.panda.tv.playback.RuleCalibrationLoader
import app.panda.tv.playback.SourceRules
import app.panda.tv.playback.SourceRulesLoader
import app.panda.tv.playback.WarmMediaCache
import app.panda.tv.state.SourceHealthStore
import app.panda.tv.state.UserStore
import app.panda.tv.state.UserStateWriter
import app.panda.tv.model.StateAction
import app.panda.tv.ui.PlaybackPreferences
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import java.io.File

class PandaTvApp : Application() {
    lateinit var userStore: UserStore
        private set
    lateinit var userWriter: UserStateWriter
        private set
    lateinit var douban: DoubanDataSource
        private set
    lateinit var sourceRules: SourceRules
        private set
    lateinit var warmCache: WarmMediaCache
        private set
    lateinit var playback: PlaybackService
        private set
    var sourceHealth: SourceHealthStore? = null
        private set
    var ruleCalibration: RuleCalibration? = null
        private set
    lateinit var images: ImageLoader
        private set

    val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    override fun onCreate() {
        super.onCreate()
        TlsCompat.installAsync(this)

        val metaDir = File(filesDir, "cache").apply { mkdirs() }
        userStore = UserStore(File(filesDir, "user-state.json"))
        userWriter = UserStateWriter(userStore, appScope, onCommitted = { action, _ ->
            if (action is StateAction.UpdateSettings) PlaybackPreferences.defaultsSaved(action)
        })
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
        ruleCalibration = RuleCalibrationLoader.load(assets)
        sourceHealth = ruleCalibration?.let { calibration ->
            SourceHealthStore(
                File(filesDir, "source-health-v1.json"),
                calibration.health,
                calibration.budget,
                onWriteFailure = { message -> Log.w("PandaTV", "[health] $message") },
            )
        }
        playback = PlaybackService(sourceRules, warmCache, health = sourceHealth, alignment = ruleCalibration?.alignment) { src, reason, ms ->
            Log.i("PandaTV", "[source] $src (${ms}ms): $reason")
        }
        images = ImageLoader(this)
    }

    fun flushAll() {
        appScope.launch(Dispatchers.IO) {
            douban.flush()
            sourceHealth?.flush()
        }
    }
}
