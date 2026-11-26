package app.panda.tv.ui

import android.app.ActivityManager
import android.content.Context
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.util.TypedValue
import android.util.Log
import android.view.Gravity
import android.view.KeyEvent
import android.view.SurfaceView
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.SeekBar
import android.widget.TextView
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.MediaItem as Media3Item
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.Tracks
import androidx.media3.common.VideoSize
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.analytics.AnalyticsListener
import androidx.media3.exoplayer.hls.HlsMediaSource
import androidx.media3.exoplayer.source.ProgressiveMediaSource
import androidx.recyclerview.widget.RecyclerView
import app.panda.tv.model.Constants
import app.panda.tv.model.Copy
import app.panda.tv.model.MediaItem
import app.panda.tv.model.PlaySources
import app.panda.tv.model.Playback
import app.panda.tv.model.Quality
import app.panda.tv.model.Rules
import app.panda.tv.model.StateAction
import app.panda.tv.playback.PandaMediaDataSource
import app.panda.tv.playback.ChapterMarks
import app.panda.tv.playback.BufferRules
import app.panda.tv.playback.BufferSample
import app.panda.tv.playback.FailureKind
import app.panda.tv.playback.RemoteSeekTarget
import app.panda.tv.playback.SwitchBudgetRules
import app.panda.tv.playback.SwitchEvent
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import java.util.concurrent.atomic.AtomicInteger

internal fun playbackFailureKind(firstFrameRendered: Boolean): FailureKind =
    if (firstFrameRendered) FailureKind.STALL else FailureKind.PROBE

@OptIn(UnstableApi::class)
class PlayerScreen(
    ctx: Context,
    nav: Navigator,
    initialItem: MediaItem,
    initialEpisode: Int,
    restored: android.os.Bundle? = null,
) : Screen(ctx, nav) {
    override fun saveRoute() = super.saveRoute().apply {
        putString("page", "player")
        putString("id", itemId)
        putInt("episode", episode)
        putBoolean("play", playRequested)
        if (playingEpisode == episode && startedPlayback) exoPlayer?.let { putDouble("position", it.currentPosition / 1000.0) }
    }

    override val showTopBar: Boolean = false

    private val m = Theme.metrics(ctx)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val root = FrameLayout(ctx).apply {
        setBackgroundColor(Color.BLACK)
        keepScreenOn = true
    }
    private val surfaceView = SurfaceView(ctx).apply {
        isFocusable = false
        isFocusableInTouchMode = false
    }
    private val videoShutter = View(ctx).apply { setBackgroundColor(Color.BLACK) }
    private val centerSpinner = ProgressBar(ctx).apply {
        indeterminateTintList = android.content.res.ColorStateList.valueOf(Theme.BAMBOO_400)
        visibility = View.VISIBLE
    }
    private val bufferingText = Theme.label(ctx, Copy.Player.PREPARING, sp = 15f, bold = true)
    private val bufferingCard = LinearLayout(ctx).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        setPadding(Theme.dp(ctx, 16), Theme.dp(ctx, 8), Theme.dp(ctx, 16), Theme.dp(ctx, 8))
        background = Theme.box(Theme.GLASS_STRONG, Theme.LINE_2, radiusDp = 999, ctx = ctx)
        addView(centerSpinner, LinearLayout.LayoutParams(Theme.dp(ctx, 24), Theme.dp(ctx, 24)).apply {
            rightMargin = Theme.dp(ctx, 10)
        })
        addView(bufferingText)
    }
    private val osdBox = LinearLayout(ctx).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        visibility = View.GONE
        setPadding(Theme.dp(ctx, 20), Theme.dp(ctx, 10), Theme.dp(ctx, 20), Theme.dp(ctx, 10))
        background = Theme.box(Theme.GLASS_STRONG, Theme.LINE_2, radiusDp = 999, ctx = ctx)
    }
    private val osdIcon = TvIconView(ctx, TvIcon.FORWARD, Theme.PAPER_100).apply {
        val sz = Theme.dp(ctx, 18)
        layoutParams = LinearLayout.LayoutParams(sz, sz).apply { rightMargin = Theme.dp(ctx, 8) }
    }
    private val osdTv = Theme.label(ctx, sp = 15f, color = Theme.PAPER_100, bold = true)

    private val topShade = LinearLayout(ctx).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        clipChildren = false
        clipToPadding = false
        setPadding(m.pageH, m.safeV + Theme.dp(ctx, 4), m.pageH, Theme.dp(ctx, 20))
        background = GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, intArrayOf(0xE00E0D0B.toInt(), Color.TRANSPARENT))
    }
    private val titleTv = Theme.label(ctx, sp = 20f, color = Theme.PAPER_100, bold = true, maxLines = 1)
    private val epTv = Theme.label(ctx, sp = 13.5f, color = Theme.PAPER_70, maxLines = 1)

    private val chaptersBtn = Theme.pillButton(ctx, "片头片尾", padH = 15, padV = 7, sp = 13.5f).apply { visibility = View.GONE }
    private val chapterPrefs = ctx.getSharedPreferences("playback-chapters-v1", Context.MODE_PRIVATE)
    private var manualIntro: Double? = null
    private var manualOutroLength: Double? = null
    private var introSkipped = false
    private var outroSkipped = false

    private val bottomShade = LinearLayout(ctx).apply {
        orientation = LinearLayout.VERTICAL
        clipChildren = false
        clipToPadding = false
        setPadding(m.pageH, Theme.dp(ctx, 20), m.pageH, m.safeV + Theme.dp(ctx, 3))
        background = GradientDrawable(GradientDrawable.Orientation.BOTTOM_TOP, intArrayOf(0xEB0E0D0B.toInt(), Color.TRANSPARENT))
    }
    private val seekBar = SeekBar(ctx).apply {
        max = 1000
        isFocusable = true
        isFocusableInTouchMode = true
        progressTintList = android.content.res.ColorStateList.valueOf(Theme.BAMBOO_400)
        thumbTintList = android.content.res.ColorStateList(
            arrayOf(intArrayOf(android.R.attr.state_focused), intArrayOf()), intArrayOf(Theme.BAMBOO_400, Theme.PAPER_50),
        )
        background = Theme.focusBox(ctx, Color.TRANSPARENT, Theme.FILL, normalStroke = 0, radiusDp = 16)
    }
    private val timeTv = Theme.label(ctx, "00:00 / 00:00", sp = 13.5f, color = Theme.PAPER_70)
    private val playPauseBtn = Theme.pillButton(ctx, Copy.Player.PAUSE, primary = true, icon = TvIcon.PAUSE, padH = 18, padV = 8, sp = 13.5f)
    private val nextBtn = Theme.pillButton(ctx, Copy.Player.NEXT, icon = TvIcon.NEXT, padH = 16, padV = 8, sp = 13.5f)
    private val episodesBtn = Theme.pillButton(ctx, Copy.Player.EPISODES, icon = TvIcon.EPISODES, padH = 16, padV = 8, sp = 13.5f)
    private val lineBtn = Theme.pillButton(ctx, Copy.Extra.LINE, icon = TvIcon.LINE, padH = 16, padV = 8, sp = 13.5f, maxTextWidthDp = 152)
    private val qualityBtn = Theme.pillButton(ctx, Copy.Player.QUALITY, icon = TvIcon.QUALITY, padH = 16, padV = 8, sp = 13.5f)
    private val qualityBadgeTv = Theme.label(ctx, sp = 12f, color = Theme.BAMBOO_400, bold = true).apply {
        visibility = View.GONE
        setPadding(Theme.dp(ctx, 11), Theme.dp(ctx, 5), Theme.dp(ctx, 11), Theme.dp(ctx, 5))
        background = Theme.box(Theme.FILL, Theme.LINE, radiusDp = 999, ctx = ctx)
    }
    private val speedBtn = Theme.pillButton(ctx, Copy.Player.SPEED, icon = TvIcon.SPEED, padH = 16, padV = 8, sp = 13.5f)

    private val panelScrim = View(ctx).apply {
        visibility = View.GONE
        setBackgroundColor(Theme.SCRIM)
        setOnClickListener { closePanel() }
    }
    private val sidePanel = LinearLayout(ctx).apply {
        orientation = LinearLayout.VERTICAL
        visibility = View.GONE
        clipChildren = false
        clipToPadding = false
        background = Theme.box(Theme.INK_900, Theme.LINE, radiusDp = 0, strokeDp = 1, ctx = ctx)
        setPadding(Theme.dp(ctx, 24), m.safeV + Theme.dp(ctx, 6), m.pageH, m.safeV)
    }
    private val sideTitleTv = Theme.label(ctx, sp = 18f, color = Theme.PAPER_100, bold = true)
    private val sideGrid = Theme.verticalGrid(ctx, sidePanel).apply {
        setNumColumns(1)
        setVerticalSpacing(Theme.dp(ctx, 12))
        setPadding(Theme.dp(ctx, 4), Theme.dp(ctx, 8), Theme.dp(ctx, 4), Theme.dp(ctx, 12))
        clipToPadding = false
        clipChildren = false
        setOnKeyInterceptListener { event ->
            if (event.action != KeyEvent.ACTION_DOWN || panelMode == null) return@setOnKeyInterceptListener false
            val last = (adapter?.itemCount ?: 1) - 1
            event.keyCode == KeyEvent.KEYCODE_DPAD_LEFT || event.keyCode == KeyEvent.KEYCODE_DPAD_RIGHT ||
                (event.keyCode == KeyEvent.KEYCODE_DPAD_UP && selectedPosition == 0) ||
                (event.keyCode == KeyEvent.KEYCODE_DPAD_DOWN && selectedPosition == last)
        }
    }

    private val upNextBox = LinearLayout(ctx).apply {
        orientation = LinearLayout.VERTICAL
        visibility = View.GONE
        clipChildren = false
        clipToPadding = false
        setPadding(Theme.dp(ctx, 20), Theme.dp(ctx, 16), Theme.dp(ctx, 20), Theme.dp(ctx, 16))
        background = Theme.box(Theme.GLASS_STRONG, Theme.LINE_2, radiusDp = 16, ctx = ctx)
    }
    private val upNextLabelTv = Theme.label(ctx, sp = 12f, color = Theme.BAMBOO_400, bold = true)
    private val upNextTitleTv = Theme.label(ctx, sp = 15f, color = Theme.PAPER_100, bold = true, maxLines = 1)
    private val upNextPlayBtn = Theme.pillButton(ctx, Copy.Player.PLAY_NOW, primary = true, padH = 14, padV = 6, sp = 12.5f)
    private val upNextCancelBtn = Theme.pillButton(ctx, Copy.Action.CANCEL, padH = 14, padV = 6, sp = 12.5f)

    private val errorBox = FrameLayout(ctx).apply {
        visibility = View.GONE
        setBackgroundColor(0xE00E0D0B.toInt())
    }

    private val itemId = initialItem.id
    private var mediaItem: MediaItem? = initialItem
    private var episode = initialEpisode
    private var playbackData: Playback? = null
    private var playSources: PlaySources? = null
    private var exoPlayer: ExoPlayer? = null
    private var lastVideoSize: VideoSize? = null
    private val initialSettings = nav.app.userStore.get().settings.also { PlaybackPreferences.observeDefaults(it) }
    private var quality: Quality = PlaybackPreferences.quality ?: initialSettings.quality
    private var actualQuality: Quality? = null
    private var lastPanelAnchor: View? = null
    private var requestedSpeed: Double = PlaybackPreferences.speed ?: initialSettings.speed
    private var speed: Double = requestedSpeed
    private var speedCleanWindows = 0
    private var speedBufferingSample = PlaybackBufferingSample(0L, 0)
    private var resumeAtSec: Double? = restored?.takeIf { it.containsKey("position") }?.getDouble("position")
    private var startedPlayback = false
    private var playingEpisode: Int? = null
    private var loadGeneration = 0L
    private var activeMediaId: String? = null
    private var screenShown = false
    private var playRequested = restored?.getBoolean("play", true) ?: true
    private var sourceStarted = false
    private var progressSample = PlaybackProgressSample(0L, android.os.SystemClock.elapsedRealtime())
    private val bufferSamples = ArrayList<BufferSample>()
    private var bufferScene = "playing"
    private val switchEvents = ArrayList<SwitchEvent>()
    private var playingSince = 0L
    private var autoAttempts = 0
    private var autoAdvanced = false
    private var upNextCancelled = false
    private var preparedNext = false
    private var overlayVisible = true
    private enum class Panel { EPISODES, LINES, QUALITY, SPEED, CHAPTERS }

    private var panelMode: Panel? = null
    private var lastControl: View? = null
    private var consumedConfirmKey: Int? = null
    private var destroyed = false
    private var lastSavedAt = 0L
    private var userSeeking = false
    private var scrubbing = false
    private var pendingRemoteSeekMs: Long? = null
    private var speedMeasureJob: Job? = null
    private var speedMeasureGeneration = 0L
    private val speedMeasureProcessedFrames = AtomicInteger()
    private val speedMeasureDropped = AtomicInteger()

    private var loadJob: Job? = null
    private var tickJob: Job? = null
    private var idleJob: Job? = null
    private var osdJob: Job? = null
    private var startupWatchJob: Job? = null
    private var startupBudget = PlaybackStartupBudget()
    private var preloadJob: Job? = null
    private var scrubbingOffJob: Job? = null
    private var seekCommitJob: Job? = null

    override val view: View get() = root

    init {
        buildLayout()
        buildPlayer()
        loadAndStart(retry = false, fromSource = null)
    }

    override fun onHidden() {
        screenShown = false
        pauseStartupWatch()
        resetProgressWatch()
        idleJob?.cancel()
        seekCommitJob?.cancel()
        pendingRemoteSeekMs = null
        saveHistory()
        exoPlayer?.pause()
    }

    override fun onShown() {
        screenShown = true
        resetProgressWatch()
        if (overlayVisible) showOverlay()
        exoPlayer?.let { p ->
            if (playRequested && playbackData != null && !p.isPlaying && errorBox.visibility != View.VISIBLE) {
                p.play()
            }
        }
        watchStartup()
    }

    override fun onDestroy() {
        destroyed = true
        loadGeneration++
        saveHistory()
        loadJob?.cancel()
        tickJob?.cancel()
        idleJob?.cancel()
        osdJob?.cancel()
        startupWatchJob?.cancel()
        preloadJob?.cancel()
        preparedNext = false
        scrubbingOffJob?.cancel()
        seekCommitJob?.cancel()
        speedMeasureJob?.cancel()
        scrubbing = false
        pendingRemoteSeekMs = null
        exoPlayer?.let { player ->
            val counters = player.videoDecoderCounters
            player.release()
            counters?.let {
                it.ensureUpdated()
                Log.i("PandaTV", "[video-summary] rendered=${it.renderedOutputBufferCount} dropped=${it.droppedBufferCount} skipped=${it.skippedOutputBufferCount}")
            }
        }
        exoPlayer = null
        scope.cancel()
    }

    override fun onBackPressed(): Boolean {
        if (panelMode != null) {
            closePanel()
            return true
        }
        if (upNextBox.hasFocus()) {
            upNextCancelled = true
            hideUpNext(restoreFocus = true)
            return true
        }
        if (overlayVisible && sourceStarted && errorBox.visibility != View.VISIBLE) {
            setOverlayVisible(false)
            return true
        }
        saveHistory()
        nav.back()
        return true
    }

    override fun dispatchRemoteKey(event: KeyEvent): Boolean {
        val mediaKey = when (event.keyCode) {
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_MEDIA_PLAY, KeyEvent.KEYCODE_MEDIA_PAUSE,
            KeyEvent.KEYCODE_MEDIA_FAST_FORWARD, KeyEvent.KEYCODE_MEDIA_REWIND -> true
            else -> false
        }
        if (event.action != KeyEvent.ACTION_DOWN) {
            if (consumedConfirmKey == event.keyCode) {
                consumedConfirmKey = null
                return true
            }
            return mediaKey
        }
        if (errorBox.visibility == View.VISIBLE || panelMode != null) return mediaKey

        when (event.keyCode) {
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE -> {
                if (event.repeatCount == 0) togglePlayPause()
                showOverlay()
                return true
            }
            KeyEvent.KEYCODE_MEDIA_PLAY -> {
                playRequested = true
                exoPlayer?.play()
                showOverlay()
                return true
            }
            KeyEvent.KEYCODE_MEDIA_PAUSE -> {
                playRequested = false
                exoPlayer?.pause()
                showOverlay()
                return true
            }
            KeyEvent.KEYCODE_MEDIA_FAST_FORWARD -> {
                seekRelative(Constants.SEEK_STEP_SECONDS, focusSeekBar = !overlayVisible, repeat = event.repeatCount)
                return true
            }
            KeyEvent.KEYCODE_MEDIA_REWIND -> {
                seekRelative(-Constants.SEEK_STEP_SECONDS, focusSeekBar = !overlayVisible, repeat = event.repeatCount)
                return true
            }
            KeyEvent.KEYCODE_MENU -> {
                if (event.repeatCount == 0) setOverlayVisible(!overlayVisible)
                return true
            }
        }

        if (!overlayVisible) {
            if (upNextBox.visibility == View.VISIBLE && upNextBox.hasFocus()) {
                if (event.keyCode == KeyEvent.KEYCODE_DPAD_UP || event.keyCode == KeyEvent.KEYCODE_DPAD_DOWN) {
                    showOverlay()
                    return true
                }
                return false
            }
            when (event.keyCode) {
                KeyEvent.KEYCODE_DPAD_LEFT -> {
                    seekRelative(-Constants.SEEK_STEP_SECONDS, focusSeekBar = true, repeat = event.repeatCount)
                    return true
                }
                KeyEvent.KEYCODE_DPAD_RIGHT -> {
                    seekRelative(Constants.SEEK_STEP_SECONDS, focusSeekBar = true, repeat = event.repeatCount)
                    return true
                }
                KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> {
                    consumedConfirmKey = event.keyCode
                    togglePlayPause()
                    showOverlay()
                    return true
                }
                KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN -> {
                    showOverlay()
                    return true
                }
            }
        } else {
            scheduleIdleHide()
        }
        return false
    }

    private fun buildLayout() {
        root.addView(surfaceView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT, Gravity.CENTER))
        root.addView(videoShutter, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        root.addOnLayoutChangeListener { _, l, t, r, b, ol, ot, or, ob ->
            if (r - l != or - ol || b - t != ob - ot) {
                lastVideoSize?.let { adjustVideoAspect(it) }
            }
        }

        root.addView(bufferingCard, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER))

        osdBox.addView(osdIcon)
        osdBox.addView(osdTv)
        root.addView(osdBox, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.CENTER_HORIZONTAL).apply {
            topMargin = m.safeV + Theme.dp(ctx, 64)
        })

        // Top shade
        topShade.addView(Theme.pillButton(ctx, Copy.Action.BACK, icon = TvIcon.BACK, padH = 15, padV = 7, sp = 13.5f).apply {
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                rightMargin = Theme.dp(ctx, 18)
            }
            setOnClickListener {
                saveHistory()
                nav.back()
            }
        })
        val heading = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
        heading.addView(titleTv)
        heading.addView(epTv.apply {
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                topMargin = Theme.dp(ctx, 2)
            }
        })
        topShade.addView(heading, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        chaptersBtn.setOnClickListener { openPanel(Panel.CHAPTERS, chaptersBtn) }
        topShade.addView(chaptersBtn)
        root.addView(topShade, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP))

        // Up Next card
        upNextBox.addView(upNextLabelTv)
        upNextBox.addView(upNextTitleTv.apply {
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                topMargin = Theme.dp(ctx, 4)
                bottomMargin = Theme.dp(ctx, 12)
            }
        })
        val upBtns = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            clipChildren = false
        }
        upNextPlayBtn.apply {
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                rightMargin = Theme.dp(ctx, 10)
            }
            setOnClickListener { advanceToNext() }
        }
        upNextCancelBtn.setOnClickListener {
            upNextCancelled = true
            hideUpNext(restoreFocus = true)
        }
        upBtns.addView(upNextPlayBtn)
        upBtns.addView(upNextCancelBtn)
        upNextBox.addView(upBtns)
        root.addView(upNextBox, FrameLayout.LayoutParams(Theme.dp(ctx, 296), ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM or Gravity.END).apply {
            setMargins(0, 0, m.pageH, Theme.dp(ctx, 134))
        })

        // Bottom controls
        seekBar.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(sb: SeekBar?, progress: Int, fromUser: Boolean) {
                if (fromUser) {
                    val dur = exoPlayer?.duration ?: 0L
                    if (dur > 0L) {
                        val posMs = dur * progress / 1000L
                        timeTv.text = "${Rules.clock(posMs / 1000.0)} / ${Rules.clock(dur / 1000.0)}"
                    }
                }
            }
            override fun onStartTrackingTouch(sb: SeekBar?) {
                userSeeking = true
                pendingRemoteSeekMs = null
                beginScrubbing()
            }
            override fun onStopTrackingTouch(sb: SeekBar?) {
                userSeeking = false
                val dur = exoPlayer?.duration ?: 0L
                if (dur > 0L) {
                    pendingRemoteSeekMs = dur * (sb?.progress ?: 0) / 1000L
                    exoPlayer?.seekTo(pendingRemoteSeekMs!!)
                }
                endScrubbingSoon()
                scheduleIdleHide()
            }
        })
        seekBar.setOnKeyListener { _, keyCode, event ->
            if (event.action != KeyEvent.ACTION_DOWN) return@setOnKeyListener false
            when (keyCode) {
                KeyEvent.KEYCODE_DPAD_LEFT -> {
                    seekRelative(-Constants.SEEK_STEP_SECONDS, focusSeekBar = false, repeat = event.repeatCount)
                    true
                }
                KeyEvent.KEYCODE_DPAD_RIGHT -> {
                    seekRelative(Constants.SEEK_STEP_SECONDS, focusSeekBar = false, repeat = event.repeatCount)
                    true
                }
                KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> {
                    consumedConfirmKey = keyCode
                    togglePlayPause()
                    scheduleIdleHide()
                    true
                }
                else -> false
            }
        }
        bottomShade.addView(seekBar, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
            bottomMargin = Theme.dp(ctx, 12)
        })

        val barRow = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            clipChildren = false
            clipToPadding = false
        }
        playPauseBtn.setOnClickListener { togglePlayPause(); scheduleIdleHide() }
        nextBtn.setOnClickListener { advanceToNext() }
        episodesBtn.setOnClickListener { openPanel(Panel.EPISODES, episodesBtn) }
        lineBtn.setOnClickListener { openPanel(Panel.LINES, lineBtn) }
        qualityBtn.setOnClickListener { openPanel(Panel.QUALITY, qualityBtn) }
        speedBtn.setOnClickListener { openPanel(Panel.SPEED, speedBtn) }

        fun addControl(v: View) {
            v.layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                rightMargin = Theme.dp(ctx, 12)
            }
            barRow.addView(v)
        }
        addControl(playPauseBtn)
        addControl(nextBtn)
        barRow.addView(timeTv, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
            leftMargin = Theme.dp(ctx, 8)
        })
        addControl(episodesBtn)
        addControl(lineBtn)
        addControl(qualityBadgeTv)
        addControl(qualityBtn)
        speedBtn.layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        barRow.addView(speedBtn)
        bottomShade.addView(barRow)
        root.addView(bottomShade, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM))

        // Side panel
        sidePanel.addView(sideTitleTv.apply {
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                bottomMargin = Theme.dp(ctx, 14)
            }
        })
        val sideListClip = FrameLayout(ctx).apply {
            clipChildren = true
            clipToPadding = true
        }
        sideListClip.addView(sideGrid, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        sidePanel.addView(sideListClip, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        root.addView(panelScrim, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        root.addView(sidePanel, FrameLayout.LayoutParams(Theme.dp(ctx, 356), ViewGroup.LayoutParams.MATCH_PARENT, Gravity.END))

        root.addView(errorBox, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        surfaceView.setOnClickListener { if (errorBox.visibility != View.VISIBLE) setOverlayVisible(!overlayVisible) }
        surfaceView.isFocusable = false
    }

    private fun buildPlayer() {
        val maxMemMb = Runtime.getRuntime().maxMemory() / (1024L * 1024L)
        val activityManager = ctx.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val memoryInfo = ActivityManager.MemoryInfo().also { activityManager.getMemoryInfo(it) }
        val buffer = PlaybackBufferPolicy.forDevice(
            maxMemoryMb = maxMemMb,
            memoryClassMb = activityManager.memoryClass,
            totalMemoryMb = memoryInfo.totalMem / (1024L * 1024L),
            lowRamDevice = activityManager.isLowRamDevice,
        )
        Log.i("PandaTV", "[buffer] lowRamDevice=${activityManager.isLowRamDevice} memoryClassMb=${activityManager.memoryClass} totalMb=${memoryInfo.totalMem / (1024L * 1024L)} maxHeapMb=$maxMemMb minMs=${buffer.minBufferMs} maxMs=${buffer.maxBufferMs} bytes=${buffer.targetBytes}")
        val loadControl = DefaultLoadControl.Builder()
            .setBufferDurationsMs(buffer.minBufferMs, buffer.maxBufferMs, 1_000, 2_000)
            .setTargetBufferBytes(buffer.targetBytes)
            .setPrioritizeTimeOverSizeThresholds(true)
            .build()
        val renderers = DefaultRenderersFactory(ctx).setEnableDecoderFallback(true)
        val player = ExoPlayer.Builder(ctx, renderers)
            .setLoadControl(loadControl)
            // Align renderer work with CPU wake cycles; this reduces needless wakeups while
            // keeping frame release responsive when playback speed changes.
            .experimentalSetDynamicSchedulingEnabled(true)
            .build()
        player.setVideoSurfaceView(surfaceView)
        player.setPlaybackParameters(player.playbackParameters.withSpeed(speed.toFloat()))
        player.addAnalyticsListener(object : AnalyticsListener {
            override fun onVideoFrameProcessingOffset(eventTime: AnalyticsListener.EventTime, totalProcessingOffsetUs: Long, frameCount: Int) {
                if (requestedSpeed > 1.0 && player.isPlaying) speedMeasureProcessedFrames.addAndGet(frameCount)
            }

            override fun onDroppedVideoFrames(eventTime: AnalyticsListener.EventTime, count: Int, elapsedMs: Long) {
                if (requestedSpeed > 1.0 && player.isPlaying) speedMeasureDropped.addAndGet(count)
            }
        })
        player.addListener(object : Player.Listener {
            private fun isCurrentMedia(): Boolean = !destroyed && playbackData != null &&
                activeMediaId != null && player.currentMediaItem?.mediaId == activeMediaId

            override fun onVideoSizeChanged(videoSize: VideoSize) {
                if (!isCurrentMedia()) return
                lastVideoSize = videoSize
                adjustVideoAspect(videoSize)
            }

            override fun onPositionDiscontinuity(
                oldPosition: Player.PositionInfo,
                newPosition: Player.PositionInfo,
                reason: Int,
            ) {
                if (!isCurrentMedia()) return
                progressSample = PlaybackProgressSample(
                    newPosition.positionMs.coerceAtLeast(0L),
                    android.os.SystemClock.elapsedRealtime(),
                )
                if (reason == Player.DISCONTINUITY_REASON_SEEK) {
                    bufferScene = "seek"
                    bufferSamples.clear()
                }
                playingSince = if (player.isPlaying) android.os.SystemClock.elapsedRealtime() else 0L
            }

            override fun onRenderedFirstFrame() {
                if (!isCurrentMedia()) return
                videoShutter.visibility = View.GONE
                sourceStarted = true
                startedPlayback = true
                startupWatchJob?.cancel()
                startupBudget.finish()
                syncButtons()
            }

            override fun onPlaybackStateChanged(playbackState: Int) {
                if (!isCurrentMedia()) return
                when (playbackState) {
                    Player.STATE_BUFFERING -> {
                        val bufferingDecision = if (
                            sourceStarted && playRequested && player.playWhenReady
                        ) {
                            PlaybackSpeedPolicy.observeBuffering(
                                speed,
                                requestedSpeed,
                                speedBufferingSample,
                                android.os.SystemClock.elapsedRealtime(),
                            )
                        } else null
                        if (bufferingDecision != null) {
                            speedBufferingSample = bufferingDecision.sample
                            if (bufferingDecision.changed) {
                                val previousSpeed = speed
                                speed = bufferingDecision.speed
                                player.setPlaybackParameters(player.playbackParameters.withSpeed(speed.toFloat()))
                                speedCleanWindows = 0
                                Log.i("PandaTV", "[speed] requested=${requestedSpeed}x reason=buffering from=${previousSpeed}x rate=${speed}x windowMs=${PlaybackSpeedPolicy.BUFFERING_WINDOW_MS}")
                                syncButtons()
                                showOsd(TvIcon.SPEED, "${Rules.speedLabel(previousSpeed)} → ${Rules.speedLabel(speed)}")
                            }
                        }
                        resetSpeedWindow()
                        showBuffering(true)
                    }
                    Player.STATE_READY -> {
                        showBuffering(false)
                        if (scrubbing) endScrubbingSoon()
                        syncButtons()
                        scheduleIdleHide()
                    }
                    Player.STATE_ENDED -> {
                        showBuffering(false)
                        val s = nav.app.userStore.get().settings
                        if (hasNextEpisode() && s.autoNext && !upNextCancelled) {
                            advanceToNext()
                        } else {
                            saveHistory()
                            showOverlay()
                        }
                    }
                    else -> {}
                }
            }

            override fun onIsPlayingChanged(isPlaying: Boolean) {
                if (!isCurrentMedia()) return
                resetProgressWatch()
                if (isPlaying) playingSince = android.os.SystemClock.elapsedRealtime()
                if (isPlaying && requestedSpeed > 1.0) measureSpeedPlayback()
                else if (!isPlaying) resetSpeedWindow()
                syncButtons()
                if (!isPlaying && startedPlayback) saveHistory()
            }

            override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
                if (!isCurrentMedia()) return
                if (playWhenReady) watchStartup() else pauseStartupWatch()
                syncButtons()
            }

            override fun onTracksChanged(tracks: Tracks) {
                if (!isCurrentMedia()) return
                for (group in tracks.groups) {
                    if (group.type == C.TRACK_TYPE_VIDEO && group.isSelected) {
                        for (i in 0 until group.length) {
                            if (group.isTrackSelected(i)) {
                                val fmt = group.getTrackFormat(i)
                                Quality.forPicture(fmt.width, fmt.height)?.let { q ->
                                    if (actualQuality != q) {
                                        actualQuality = q
                                        syncButtons()
                                    }
                                }
                                break
                            }
                        }
                    }
                }
            }

            override fun onPlayerError(error: PlaybackException) {
                if (isCurrentMedia()) handlePlaybackFailure(error)
            }
        })
        exoPlayer = player
        startTickLoop()
    }

    private fun adjustVideoAspect(size: VideoSize) {
        if (size.width <= 0 || size.height <= 0) return
        val parentW = root.width
        val parentH = root.height
        if (parentW <= 0 || parentH <= 0) return
        val videoAspect = (size.width * size.pixelWidthHeightRatio) / size.height.toFloat()
        val viewAspect = parentW.toFloat() / parentH.toFloat()
        val lp = surfaceView.layoutParams as FrameLayout.LayoutParams
        if (videoAspect > viewAspect) {
            lp.width = parentW
            lp.height = (parentW / videoAspect).toInt()
        } else {
            lp.width = (parentH * videoAspect).toInt()
            lp.height = parentH
        }
        lp.gravity = Gravity.CENTER
        surfaceView.layoutParams = lp
    }

    private fun loadAndStart(
        retry: Boolean,
        fromSource: String?,
        retryFailureKind: FailureKind? = null,
        userRetry: Boolean = false,
        retainCurrent: Boolean = false,
    ) {
        preparedNext = false
        seekCommitJob?.cancel()
        scrubbingOffJob?.cancel()
        scrubbing = false
        pendingRemoteSeekMs = null
        exoPlayer?.setScrubbingModeEnabled(false)
        saveHistory()
        val generation = ++loadGeneration
        val targetEpisode = episode
        val switchingFrom = playbackData?.takeIf { playingEpisode == targetEpisode }
        val targetQuality = quality
        val targetResume = resumeAtSec
        speedBufferingSample = PlaybackBufferingSample(0L, 0)
        bufferScene = "playing"
        bufferSamples.clear()
        val keepPicture = playbackData != null && playingEpisode == targetEpisode && videoShutter.visibility == View.GONE
        val keepPlaying = keepPicture && sourceStarted && (!retry || retainCurrent)
        resumeAtSec = null
        loadJob?.cancel()
        startupWatchJob?.cancel()
        preloadJob?.cancel()
        idleJob?.cancel()
        if (!keepPicture) {
            // A different episode must never show or save the old episode's media.
            activeMediaId = null
            startedPlayback = false
            playingEpisode = null
            sourceStarted = false
            playbackData = null
            playSources = null
            actualQuality = null
            lastVideoSize = null
            videoShutter.visibility = View.VISIBLE
            exoPlayer?.apply {
                pause()
                stop()
                clearMediaItems()
            }
            seekBar.progress = 0
            seekBar.secondaryProgress = 0
            timeTv.text = "00:00 / 00:00"
            userSeeking = false
            hideUpNext(restoreFocus = false)
            osdJob?.cancel()
            osdBox.visibility = View.GONE
            preparedNext = false
            autoAdvanced = false
            upNextCancelled = false
        }
        errorBox.visibility = View.GONE
        showOverlay()
        if (!keepPlaying) {
            sourceStarted = false
            showBuffering(true)
        }
        mediaItem?.let { updateHeader(it) }
        syncButtons()

        loadJob = scope.launch {
            try {
                val item = mediaItem ?: return@launch
                val dataSource = nav.app.douban
                val playbackService = nav.app.playback
                val (resolved, hints) = awaitScreenRequest(scope, timeoutMs = 40_000L) {
                    val workHints = dataSource.workHints(item.id)
                    var candidate: Playback? = null
                    var lastError: Throwable? = null
                    val maxTries = if (retry || fromSource != null) 1 else 3
                    for (attempt in 0 until maxTries) {
                        try {
                            candidate = playbackService.resolve(item, targetEpisode, targetQuality, retry = retry,
                                hints = workHints, from = fromSource, retryFailureKind = retryFailureKind, switchingFrom = switchingFrom, userRetry = userRetry)
                            break
                        } catch (cancelled: CancellationException) {
                            throw cancelled
                        } catch (error: Throwable) {
                            lastError = error
                            val message = error.message.orEmpty()
                            val finalAnswer = message in listOf(
                                Copy.Extra.SOURCE_UNAVAILABLE, Copy.Extra.NO_EPISODE,
                                Copy.Extra.NOT_FOUND, Copy.Extra.INVALID_INPUT, Copy.Extra.UNSUPPORTED_PLAYBACK,
                            )
                            if (finalAnswer || attempt == maxTries - 1) break
                            delay(800L)
                        }
                    }
                    (candidate ?: throw (lastError ?: IllegalStateException(Copy.Extra.PLAYER_RETRY))) to workHints
                }
                coroutineContext.ensureActive()
                if (destroyed || generation != loadGeneration) return@launch
                // During catalogue lookup the viewer can keep watching, pause or seek.
                if (retainCurrent && keepPlaying && resolved.sourceKey == switchingFrom?.sourceKey && exoPlayer?.playerError == null) return@launch
                val position = if (keepPlaying) exoPlayer?.currentPosition?.div(1000.0) ?: targetResume else targetResume
                saveHistory()
                sourceStarted = false
                startedPlayback = false
                playingSince = 0L
                playbackData = resolved
                val prefix = "$itemId:${resolved.sourceKey}:"
                manualIntro = chapterPrefs.getFloat(prefix + "intro", 0f).takeIf { it > 0 }?.toDouble()
                manualOutroLength = chapterPrefs.getFloat(prefix + "outro", 0f).takeIf { it > 0 }?.toDouble()
                introSkipped = false
                outroSkipped = false
                startExoPlayer(item, resolved, targetEpisode, position, generation)
                if (resolved.format == "mp4" && resolved.intro == null && resolved.outro == null) launch {
                    val marks = runCatching { playbackService.mp4Chapters(resolved.url) }.getOrNull()
                    coroutineContext.ensureActive()
                    if (!destroyed && generation == loadGeneration && marks != null) {
                        playbackData = resolved.copy(intro = marks.intro, outro = marks.outro)
                    }
                }

                launch {
                    for (complete in listOf(false, true)) {
                        val srcs = runCatching { playbackService.sources(item, targetEpisode, hints, complete) }.getOrNull()
                        val available = if (complete) runCatching { playbackService.availability(item, hints, true) }.getOrNull() else null
                        coroutineContext.ensureActive()
                        if (destroyed || generation != loadGeneration) return@launch
                        val oldSources = playSources
                        val oldItem = mediaItem
                        val panel = panelMode
                        val focusedSource = oldSources?.list?.getOrNull(sideGrid.selectedPosition)?.key
                        val focusedPosition = sideGrid.selectedPosition
                        if (srcs != null) playSources = srcs
                        if (available?.episodes != null) {
                            mediaItem = item.copy(episodes = available.episodes, episodeTitles = available.episodeTitles ?: item.episodeTitles)
                            mediaItem?.let(::updateHeader)
                        }
                        syncButtons()
                        if (panel == Panel.LINES && oldSources != playSources) {
                            openPanel(panel, lineBtn)
                            val position = playSources?.list?.indexOfFirst { it.key == focusedSource } ?: -1
                            if (position >= 0) sideGrid.selectedPosition = position
                        } else if (panel == Panel.EPISODES && oldItem != mediaItem) {
                            openPanel(panel, episodesBtn)
                            if (focusedPosition >= 0) sideGrid.selectedPosition = focusedPosition
                        }
                    }
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (t: Throwable) {
                if (destroyed || generation != loadGeneration) return@launch
                if (keepPlaying && sourceStarted && exoPlayer?.playerError == null) {
                    if (!retainCurrent) showOsd(TvIcon.REFRESH, Copy.Extra.LINE_SWITCH_FAILED)
                    scheduleIdleHide()
                } else if (keepPicture && autoAttempts in 1 until 2) {
                    handlePlaybackFailure(t, null)
                } else {
                    showError(t)
                }
            }
        }
    }

    private fun startExoPlayer(item: MediaItem, pb: Playback, targetEpisode: Int, targetResume: Double?, generation: Long) {
        val player = exoPlayer ?: return
        actualQuality = pb.quality
        val h = nav.app.userStore.get().history.firstOrNull { it.id == item.id }
        val startSec = targetResume ?: Rules.resumePosition(h, targetEpisode).takeIf { it > 0.0 }
            ?: Rules.startPosition(pb, nav.app.userStore.get().settings)

        val dsFactory = PandaMediaDataSource.Factory(nav.app.warmCache, nav.app.sourceRules)
        val mediaId = "$itemId:$targetEpisode:$generation"
        val m3Item = Media3Item.Builder().setUri(pb.url).setMediaId(mediaId).build()
        val source = if (pb.format == "hls") {
            HlsMediaSource.Factory(dsFactory).createMediaSource(m3Item)
        } else {
            ProgressiveMediaSource.Factory(dsFactory).createMediaSource(m3Item)
        }
        playingEpisode = targetEpisode
        activeMediaId = mediaId
        startupBudget = PlaybackStartupBudget()
        player.setMediaSource(source, (startSec * 1000.0).toLong().coerceAtLeast(0L))
        player.prepare()
        player.playWhenReady = screenShown && playRequested
        progressSample = PlaybackProgressSample(0L, android.os.SystemClock.elapsedRealtime())
        syncButtons()

        watchStartup()
    }

    private fun pauseStartupWatch() {
        startupWatchJob?.cancel()
        startupWatchJob = null
        startupBudget.pause(android.os.SystemClock.elapsedRealtime())
    }

    private fun watchStartup() {
        pauseStartupWatch()
        val player = exoPlayer ?: return
        if (destroyed || !screenShown || !playRequested || !player.playWhenReady || sourceStarted ||
            playbackData == null || errorBox.visibility == View.VISIBLE) return
        val generation = loadGeneration
        val remaining = startupBudget.resume(android.os.SystemClock.elapsedRealtime())
        startupWatchJob = scope.launch {
            delay(remaining)
            if (!destroyed && generation == loadGeneration && screenShown && playRequested &&
                player.playWhenReady && !sourceStarted && errorBox.visibility != View.VISIBLE) {
                handlePlaybackFailure(IllegalStateException("startup timeout"))
            }
        }
    }

    private fun resetProgressWatch() {
        bufferSamples.clear()
        progressSample = PlaybackProgressSample(exoPlayer?.currentPosition?.coerceAtLeast(0L) ?: 0L, android.os.SystemClock.elapsedRealtime())
        playingSince = 0L
    }

    private fun handlePlaybackFailure(
        cause: Throwable,
        kind: FailureKind? = playbackFailureKind(sourceStarted),
        retainCurrent: Boolean = false,
    ): Boolean {
        if (destroyed || retainCurrent && loadJob?.isActive == true) return false
        val budget = nav.app.ruleCalibration?.budget
        val decision = budget?.let { SwitchBudgetRules.evaluateSwitch(switchEvents, System.currentTimeMillis(), it) }
            ?: app.panda.tv.playback.SwitchDecision(autoAttempts < 2, if (autoAttempts < 2) null else "limit", autoAttempts)
        if (retainCurrent && !decision.allowed) return false
        scrubbingOffJob?.cancel()
        scrubbing = false
        pendingRemoteSeekMs = null
        exoPlayer?.setScrubbingModeEnabled(false)
        saveHistory()
        val p = exoPlayer
        if (p != null && p.duration > 0L) resumeAtSec = p.currentPosition.coerceAtLeast(0L) / 1000.0
        Log.i("PandaTV", "[recovery] episode=$episode source=${playbackData?.sourceKey} reason=${cause.message?.take(100)} allowed=${decision.allowed} budget=${decision.reason}")
        if (decision.allowed) {
            switchEvents.add(SwitchEvent(System.currentTimeMillis(), "auto"))
            autoAttempts = decision.attempts + 1
            showOsd(TvIcon.REFRESH, Copy.Extra.RESTORING_SOURCE)
            loadAndStart(retry = true, fromSource = null, retryFailureKind = if (retainCurrent) null else kind, retainCurrent = retainCurrent)
        } else {
            showError(IllegalStateException(Copy.Extra.PLAYER_RETRY, cause))
        }
        return true
    }

    private fun showError(t: Throwable) {
        startedPlayback = false
        sourceStarted = false
        activeMediaId = null
        videoShutter.visibility = View.VISIBLE
        exoPlayer?.pause()
        exoPlayer?.stop()
        exoPlayer?.clearMediaItems()
        showBuffering(false)
        closePanel(restoreFocus = false)
        hideUpNext(restoreFocus = false)
        osdBox.visibility = View.GONE
        topShade.visibility = View.GONE
        bottomShade.visibility = View.GONE
        topShade.descendantFocusability = ViewGroup.FOCUS_AFTER_DESCENDANTS
        bottomShade.descendantFocusability = ViewGroup.FOCUS_AFTER_DESCENDANTS
        errorBox.removeAllViews()
        val msg = Copy.errorText(t)
        val box = Theme.emptyOrErrorBox(ctx, msg, Copy.Action.RETRY, focusRetry = true) {
            autoAttempts = 0
            switchEvents.clear()
            loadAndStart(retry = true, fromSource = null, userRetry = true)
        }
        box.addView(Theme.pillButton(ctx, Copy.Action.BACK, icon = TvIcon.BACK).apply {
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                gravity = Gravity.CENTER_HORIZONTAL
                topMargin = Theme.dp(ctx, 12)
            }
            setOnClickListener { nav.back() }
        })
        errorBox.addView(box)
        errorBox.visibility = View.VISIBLE
    }

    private fun showBuffering(visible: Boolean) {
        if (visible) bufferingText.text = if (sourceStarted) Copy.Player.BUFFERING else Copy.Player.PREPARING
        bufferingCard.visibility = if (visible) View.VISIBLE else View.GONE
    }

    private fun hideUpNext(restoreFocus: Boolean) {
        if (upNextBox.visibility != View.VISIBLE) return
        val hadFocus = upNextBox.hasFocus()
        upNextBox.visibility = View.GONE
        if (hadFocus && restoreFocus) showOverlay(lastControl?.takeIf { it.visibility == View.VISIBLE } ?: playPauseBtn)
    }

    private fun startTickLoop() {
        tickJob?.cancel()
        tickJob = scope.launch {
            while (!destroyed) {
                delay(1000L)
                val p = exoPlayer ?: continue
                if (errorBox.visibility == View.VISIBLE || playbackData == null) continue
                val durMs = p.duration.takeIf { it > 0L } ?: 0L
                val posMs = p.currentPosition.coerceAtLeast(0L)
                val nowMs = android.os.SystemClock.elapsedRealtime()
                val monitoring = screenShown && sourceStarted && playRequested && p.playWhenReady && !userSeeking && !scrubbing &&
                    p.playbackState != Player.STATE_IDLE && p.playbackState != Player.STATE_ENDED
                val previousPosition = progressSample.positionMs
                progressSample = PlaybackProgressPolicy.observe(posMs, nowMs, progressSample, monitoring)
                if (monitoring) {
                    val bufferedAhead = (p.bufferedPosition - posMs).coerceAtLeast(0L) / 1000.0
                    val bufferedToEnd = durMs > 0L && p.bufferedPosition >= durMs - 50L
                    bufferSamples.add(BufferSample(nowMs, bufferedAhead, posMs / 1000.0, bufferedToEnd))
                    bufferSamples.removeAll { nowMs - it.at > 30_000L }
                    val config = nav.app.ruleCalibration?.buffer
                    val verdict = config?.let { BufferRules.shouldTakeOver(bufferScene, bufferSamples, it) }
                    if (bufferScene == "seek") bufferScene = "playing"
                    if (config != null && verdict?.takeOver == true && PlaybackProgressPolicy.needsBufferRecovery(
                            verdict.reason, p.playbackState == Player.STATE_BUFFERING, (playSources?.list?.size ?: 0) > 1,
                            nowMs - progressSample.advancedAtMs, config.playingRiseWindowSec)) {
                        val recovering = handlePlaybackFailure(IllegalStateException("${verdict.reason} buffer takeover"),
                            retainCurrent = verdict.reason == "low-buffer")
                        if (recovering) {
                            progressSample = PlaybackProgressSample(posMs, nowMs)
                            continue
                        }
                    }
                }
                if (monitoring && sourceStarted) {
                    val sourceKey = playbackData?.sourceKey
                    val stalling = p.playbackState == Player.STATE_BUFFERING || (p.isPlaying && posMs <= previousPosition)
                    if (sourceKey != null) nav.app.sourceHealth?.updateLive(
                        sourceKey,
                        playSeconds = if (p.isPlaying && !stalling) 1.0 else 0.0,
                        stallSeconds = if (stalling) 1.0 else 0.0,
                    )
                }
                if (monitoring && p.isPlaying) {
                    if (playingSince == 0L) playingSince = nowMs
                    if (autoAttempts > 0 && nowMs - playingSince > 60_000L) {
                        autoAttempts = 0
                    }
                } else playingSince = 0L
                if (monitoring && PlaybackProgressPolicy.isStalled(nowMs, progressSample)) {
                    progressSample = PlaybackProgressSample(posMs, nowMs)
                    handlePlaybackFailure(IllegalStateException("stall timeout"))
                    continue
                }

                if (durMs > 0L && !userSeeking) {
                    val shownPosition = pendingRemoteSeekMs ?: posMs
                    seekBar.progress = ((shownPosition * 1000L) / durMs).toInt().coerceIn(0, 1000)
                    seekBar.secondaryProgress = ((p.bufferedPosition * 1000L) / durMs).toInt().coerceIn(0, 1000)
                    val posSec = posMs / 1000.0
                    val durSec = durMs / 1000.0
                    val clock = "${Rules.clock(shownPosition / 1000.0)} / ${Rules.clock(durSec)}"
                    if (timeTv.text != clock) timeTv.text = clock

                    val settings = nav.app.userStore.get().settings
                    if (!preparedNext && durSec - posSec <= 90.0 && hasNextEpisode()) {
                        preparedNext = true
                        mediaItem?.let { item ->
                            val targetEpisode = episode + 1
                            val targetQuality = quality
                            preloadJob = scope.launch {
                                runCatching {
                                    nav.app.playback.resolve(item, targetEpisode, targetQuality, hints = nav.app.douban.workHints(item.id))
                                }
                            }
                        }
                    }
                    if (startedPlayback && System.currentTimeMillis() - lastSavedAt >= Constants.HISTORY_SAVE_SECONDS * 1000L) {
                        saveHistory()
                    }
                    val marks = ChapterMarks(playbackData?.intro, playbackData?.outro).withManual(manualIntro, manualOutroLength, durSec)
                    val end = if (settings.skipIntro) marks.outro ?: durSec else durSec
                    if (monitoring && settings.skipIntro) {
                        val opening = marks.intro
                        if (!introSkipped && opening != null && posSec >= opening.start && posSec < opening.end && opening.end < durSec) {
                            introSkipped = true
                            p.seekTo((opening.end * 1000).toLong())
                            showOsd(TvIcon.FORWARD, "已跳过片头")
                            continue
                        }
                        if (!outroSkipped && marks.outro != null && posSec >= end && end < durSec) {
                            outroSkipped = true
                            if (hasNextEpisode() && settings.autoNext && !upNextCancelled) advanceToNext() else p.seekTo(durMs)
                            continue
                        }
                    }
                    val up = Rules.upNextSeconds(posSec, end, hasNextEpisode(), settings.autoNext, upNextCancelled)
                    if (up != null && panelMode == null) {
                        val wasGone = upNextBox.visibility != View.VISIBLE
                        upNextBox.visibility = View.VISIBLE
                        upNextLabelTv.text = Copy.fmt(Copy.Player.UP_NEXT, "n" to up)
                        upNextTitleTv.text = mediaItem?.let { Rules.episodeHeading(it, episode + 1) } ?: ""
                        if (wasGone && !overlayVisible) {
                            upNextPlayBtn.post { if (!destroyed && !overlayVisible && panelMode == null && upNextPlayBtn.isShown) upNextPlayBtn.requestFocus() }
                        }
                    } else {
                        hideUpNext(restoreFocus = true)
                    }
                }
            }
        }
    }

    private fun updateHeader(item: MediaItem) {
        titleTv.text = item.title
        val heading = Rules.episodeHeading(item, episode)
        epTv.visibility = if (heading != null) View.VISIBLE else View.GONE
        epTv.text = heading ?: ""
        nextBtn.visibility = if (hasNextEpisode()) View.VISIBLE else View.GONE
        episodesBtn.visibility = if ((item.episodes ?: 0) > 1) View.VISIBLE else View.GONE
    }

    private fun syncButtons() {
        val playing = playRequested && screenShown && exoPlayer?.playbackState != Player.STATE_ENDED
        (playPauseBtn.getChildAt(0) as? TvIconView)?.setIcon(if (playing) TvIcon.PAUSE else TvIcon.PLAY)
        (playPauseBtn.getChildAt(1) as? TextView)?.text = if (playing) Copy.Player.PAUSE else Copy.Player.PLAY
        (speedBtn.getChildAt(1) as? TextView)?.text = if (speed == 1.0) Copy.Player.SPEED else Rules.speedLabel(speed)

        val pb = playbackData
        val qs = pb?.qualities ?: emptyList()
        val shownQuality = actualQuality ?: pb?.quality
        if (qs.size > 1) {
            qualityBtn.visibility = View.VISIBLE
            (qualityBtn.getChildAt(1) as? TextView)?.text = (shownQuality ?: quality).label
            qualityBadgeTv.visibility = View.GONE
        } else {
            qualityBtn.visibility = View.GONE
            if (shownQuality != null) {
                qualityBadgeTv.text = shownQuality.label
                qualityBadgeTv.visibility = View.VISIBLE
            } else {
                qualityBadgeTv.visibility = View.GONE
            }
        }

        chaptersBtn.visibility = if (pb?.sourceKey != null && sourceStarted && (exoPlayer?.duration ?: 0L) > 0) View.VISIBLE else View.GONE
        val srcs = playSources
        lineBtn.visibility = if (srcs != null && srcs.list.size > 1) View.VISIBLE else View.GONE
        val curName = srcs?.list?.firstOrNull { it.key == srcs.current }?.name
        (lineBtn.getChildAt(1) as? TextView)?.text = if (curName != null) "${Copy.Extra.LINE}: $curName" else Copy.Extra.LINE
    }

    private fun togglePlayPause() {
        val p = exoPlayer ?: return
        if (playRequested) {
            playRequested = false
            pauseStartupWatch()
            resetProgressWatch()
            p.pause()
            showOsd(TvIcon.PAUSE, Copy.Player.PAUSE)
        } else {
            playRequested = true
            resetProgressWatch()
            p.play()
            watchStartup()
            showOsd(TvIcon.PLAY, Copy.Player.PLAY)
        }
    }

    private fun seekRelative(deltaSec: Int, focusSeekBar: Boolean, repeat: Int = 0) {
        val p = exoPlayer ?: return
        val dur = p.duration
        if (dur <= 0L) return
        val multiplier = when {
            repeat >= 12 -> 3
            repeat >= 5 -> 2
            else -> 1
        }
        val target = RemoteSeekTarget.relative(p.currentPosition, pendingRemoteSeekMs, deltaSec * multiplier * 1000L, dur) ?: return
        pendingRemoteSeekMs = target
        seekCommitJob?.cancel()
        scrubbingOffJob?.cancel()
        seekCommitJob = scope.launch {
            delay(110L)
            if (!screenShown || destroyed || exoPlayer !== p) return@launch
            beginScrubbing()
            p.seekTo(target)
            endScrubbingSoon()
        }
        seekBar.progress = ((target * 1000L) / dur).toInt().coerceIn(0, 1000)
        timeTv.text = "${Rules.clock(target / 1000.0)} / ${Rules.clock(dur / 1000.0)}"
        showOsd(
            if (deltaSec >= 0) TvIcon.FORWARD else TvIcon.REWIND,
            Copy.fmt(Copy.Player.SEEK_TO, "time" to Rules.clock(target / 1000.0)),
        )
        showOverlay(focusTarget = if (focusSeekBar) seekBar else null)
    }

    /** Keep rapid remote seeks responsive; Media3 uses a higher codec operating rate while this is on. */
    private fun beginScrubbing() {
        scrubbing = true
        scrubbingOffJob?.cancel()
        exoPlayer?.setScrubbingModeEnabled(true)
    }

    private fun endScrubbingSoon() {
        scrubbingOffJob?.cancel()
        scrubbingOffJob = scope.launch {
            val player = exoPlayer ?: return@launch
            // Keep the operating rate elevated until the seek refill is ready, then give the
            // decoder a short quiet window before returning to normal playback scheduling.
            while (!destroyed) {
                if (player.playbackState == Player.STATE_BUFFERING) {
                    val refilled = withTimeoutOrNull(15_000L) {
                        while (!destroyed && player.playbackState == Player.STATE_BUFFERING) delay(50L)
                        true
                    } ?: false
                    if (!refilled) {
                        if (!destroyed && exoPlayer === player) {
                            scrubbing = false
                            pendingRemoteSeekMs = null
                            player.setScrubbingModeEnabled(false)
                        }
                        return@launch
                    }
                }
                delay(320L)
                if (player.playbackState != Player.STATE_BUFFERING) break
            }
            if (!destroyed && exoPlayer === player && player.playbackState != Player.STATE_BUFFERING) {
                scrubbing = false
                pendingRemoteSeekMs = null
                player.setScrubbingModeEnabled(false)
            }
        }
    }

    private fun changeSpeed(next: Double) {
        if (requestedSpeed == next) return
        requestedSpeed = next
        speed = requestedSpeed
        speedCleanWindows = 0
        speedBufferingSample = PlaybackBufferingSample(0L, 0)
        PlaybackPreferences.speed = requestedSpeed
        exoPlayer?.let { it.setPlaybackParameters(it.playbackParameters.withSpeed(speed.toFloat())) }
        measureSpeedPlayback()
        syncButtons()
        showOsd(TvIcon.SPEED, Rules.speedLabel(speed))
        scheduleIdleHide()
    }

    private fun resetSpeedWindow() {
        speedMeasureJob?.cancel()
        speedMeasureGeneration++
        speedCleanWindows = 0
        speedMeasureProcessedFrames.set(0)
        speedMeasureDropped.set(0)
    }

    /** Use public Media3 analytics callbacks to adapt only after measured ten-second windows. */
    private fun measureSpeedPlayback() {
        speedMeasureJob?.cancel()
        val generation = ++speedMeasureGeneration
        speedMeasureProcessedFrames.set(0)
        speedMeasureDropped.set(0)
        speedCleanWindows = 0
        if (requestedSpeed <= 1.0) return
        val player = exoPlayer ?: return
        if (!player.isPlaying) return
        speedMeasureJob = scope.launch {
            while (!destroyed && generation == speedMeasureGeneration && exoPlayer === player && requestedSpeed > 1.0 && player.isPlaying) {
                val measuredSpeed = speed
                speedMeasureProcessedFrames.set(0)
                speedMeasureDropped.set(0)
                val startedAt = android.os.SystemClock.elapsedRealtime()
                delay(PlaybackSpeedPolicy.WINDOW_MS)
                if (destroyed || generation != speedMeasureGeneration || exoPlayer !== player) break
                val elapsed = android.os.SystemClock.elapsedRealtime() - startedAt
                val sampledFrames = speedMeasureProcessedFrames.get()
                val dropped = speedMeasureDropped.get()
                // Media3 reports offset samples for rendered, skipped and dropped frames.
                val rendered = (sampledFrames - dropped).coerceAtLeast(0)
                val decision = PlaybackSpeedPolicy.evaluate(speed, requestedSpeed, rendered, dropped, speedCleanWindows, elapsed)
                speedCleanWindows = decision.cleanWindows
                Log.i("PandaTV", "[speed] requested=${requestedSpeed}x rate=${measuredSpeed}x next=${decision.speed}x elapsedMs=$elapsed renderedFrames=$rendered droppedFrames=$dropped")
                if (decision.changed) {
                    speed = decision.speed
                    player.setPlaybackParameters(player.playbackParameters.withSpeed(speed.toFloat()))
                    syncButtons()
                    showOsd(TvIcon.SPEED, "${Rules.speedLabel(measuredSpeed)} → ${Rules.speedLabel(speed)}")
                }
            }
        }
    }

    private fun changeQuality(next: Quality) {
        if (next == (actualQuality ?: playbackData?.quality ?: quality)) return
        quality = next
        PlaybackPreferences.quality = quality
        exoPlayer?.let { if (it.currentPosition > 0L) resumeAtSec = it.currentPosition / 1000.0 }
        loadAndStart(retry = false, fromSource = playSources?.current)
    }

    private fun hasNextEpisode(): Boolean {
        val total = mediaItem?.episodes ?: 0
        return total > 0 && episode < total
    }

    private fun advanceToNext() {
        if (!hasNextEpisode() || autoAdvanced) return
        autoAdvanced = true
        selectEpisode(episode + 1)
    }

    private fun selectEpisode(targetEpisode: Int) {
        saveHistory()
        startedPlayback = false
        episode = targetEpisode
        resumeAtSec = 0.0
        playRequested = true
        autoAttempts = 0
        switchEvents.clear()
        bufferSamples.clear()
        bufferScene = "playing"
        closePanel()
        loadAndStart(retry = false, fromSource = null)
    }

    private fun saveHistory() {
        val item = mediaItem ?: return
        val p = exoPlayer ?: return
        if (!startedPlayback || p.duration <= 0L) return
        val recordedEpisode = playingEpisode ?: return
        val posSec = p.currentPosition.coerceAtLeast(0L) / 1000.0
        val durSec = p.duration / 1000.0
        val entry = Rules.historyRecord(item.id, recordedEpisode, posSec, durSec, recordedEpisode < (item.episodes ?: 0))
            .copy(at = System.currentTimeMillis())
        lastSavedAt = System.currentTimeMillis()
        nav.saveUser(StateAction.RecordHistory(entry))
    }

    private fun openPanel(mode: Panel, anchor: View) {
        val title: String
        val count: Int
        val selected: Int
        val label: (Int) -> String
        val pick: (Int) -> Unit
        when (mode) {
            Panel.EPISODES -> {
                val item = mediaItem ?: return
                count = item.episodes ?: return
                selected = (episode - 1).coerceAtLeast(0).coerceAtMost(count - 1)
                title = Copy.Player.EPISODES
                label = { index ->
                    val ep = index + 1
                    val name = Rules.episodeLabel(item, ep)
                    item.episodeTitles?.getOrNull(index)?.takeIf { it.isNotBlank() }?.let { "$name · $it" } ?: name
                }
                pick = { if (it != selected) selectEpisode(it + 1) }
            }
            Panel.LINES -> {
                val sources = playSources ?: return
                count = sources.list.size
                selected = sources.list.indexOfFirst { it.key == sources.current }
                title = Copy.Extra.LINE
                label = { sources.list[it].name }
                pick = { index ->
                    if (index != selected) {
                        exoPlayer?.let { if (it.currentPosition > 0L) resumeAtSec = it.currentPosition / 1000.0 }
                        showOsd(TvIcon.REFRESH, Copy.Extra.SWITCHING_LINE)
                        autoAttempts = 0
                        loadAndStart(retry = false, fromSource = sources.list[index].key)
                    }
                }
            }
            Panel.QUALITY -> {
                val qualities = playbackData?.qualities ?: return
                count = qualities.size
                selected = qualities.indexOf(actualQuality ?: playbackData?.quality ?: quality)
                title = Copy.Player.QUALITY
                label = { qualities[it].label }
                pick = { changeQuality(qualities[it]) }
            }
            Panel.CHAPTERS -> {
                val player = exoPlayer ?: return
                val duration = player.duration / 1000.0
                val position = player.currentPosition / 1000.0
                val source = playbackData?.sourceKey ?: return
                if (duration <= 0.0) return
                val at = Rules.clock(position)
                val labels = mutableListOf("片头结束于 $at", "片尾开始于 $at")
                if (manualIntro != null || manualOutroLength != null) labels.add("清除手动标记")
                title = "设置片头片尾 · 本作品当前线路"
                count = labels.size
                selected = -1
                label = { labels[it] }
                pick = { index -> saveChapterMark("$itemId:$source:", index, position, duration) }
            }
            Panel.SPEED -> {
                count = Constants.SPEEDS.size
                selected = Constants.SPEEDS.indexOf(requestedSpeed)
                title = Copy.Player.SPEED
                label = { Rules.speedLabel(Constants.SPEEDS[it]) }
                pick = { changeSpeed(Constants.SPEEDS[it]) }
            }
        }
        if (count < 1) return
        panelMode = mode
        lastPanelAnchor = anchor
        idleJob?.cancel()
        hideUpNext(restoreFocus = false)
        osdBox.visibility = View.GONE
        topShade.visibility = View.INVISIBLE
        bottomShade.visibility = View.INVISIBLE
        panelScrim.visibility = View.VISIBLE
        sideTitleTv.text = title
        sideGrid.adapter = object : RecyclerView.Adapter<RecyclerView.ViewHolder>() {
            override fun getItemCount(): Int = count
            override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder =
                object : RecyclerView.ViewHolder(panelRowView()) {}

            override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
                val row = holder.itemView as TextView
                row.isSelected = position == selected
                val name = label(position)
                row.text = if (row.isSelected && mode != Panel.EPISODES) "$name ✓" else name
                row.setOnClickListener {
                    if (panelMode == mode) {
                        closePanel()
                        pick(position)
                    }
                }
            }
        }
        sidePanel.visibility = View.VISIBLE
        sidePanel.animate().cancel()
        sidePanel.alpha = 0.85f
        sidePanel.translationX = Theme.dp(ctx, 14).toFloat()
        sidePanel.animate().alpha(1f).translationX(0f).setDuration(135L).setInterpolator(Theme.decelerate).start()
        sideGrid.selectedPosition = selected.coerceAtLeast(0)
        sideGrid.requestFocus()
        sideGrid.post {
            if (!destroyed && panelMode == mode && !sideGrid.hasFocus()) sideGrid.requestFocus()
        }
    }

    private fun saveChapterMark(prefix: String, index: Int, position: Double, duration: Double) {
        if (index == 2) {
            chapterPrefs.edit().remove(prefix + "intro").remove(prefix + "outro").apply()
            manualIntro = null
            manualOutroLength = null
            nav.toast("手动标记已清除")
            return
        }
        if (position <= 0.0 || position >= duration ||
            (index == 0 && position >= duration - (manualOutroLength ?: 0.0)) ||
            (index == 1 && position <= (manualIntro ?: 0.0))) {
            nav.toast("请在有效的片头或片尾位置设置")
            return
        }
        if (index == 0) {
            chapterPrefs.edit().putFloat(prefix + "intro", position.toFloat()).apply()
            manualIntro = position
            introSkipped = true
            nav.toast("已记住片头结束时间 " + Rules.clock(position))
        } else {
            chapterPrefs.edit().putFloat(prefix + "outro", (duration - position).toFloat()).apply()
            manualOutroLength = duration - position
            outroSkipped = true
            nav.toast("已记住片尾时长 " + Rules.clock(duration - position))
        }
    }

    private fun closePanel(restoreFocus: Boolean = true) {
        if (panelMode == null) return
        panelMode = null
        sidePanel.animate().cancel()
        sidePanel.visibility = View.GONE
        sidePanel.alpha = 1f
        sidePanel.translationX = 0f
        sideGrid.adapter = null
        panelScrim.visibility = View.GONE
        val target = lastPanelAnchor?.takeIf { it.visibility == View.VISIBLE } ?: playPauseBtn
        lastPanelAnchor = null
        if (restoreFocus) showOverlay(target)
    }

    private fun panelRowView(): TextView = TextView(ctx).apply {
        setTextSize(TypedValue.COMPLEX_UNIT_PX, 14f * Theme.unit(ctx))
        maxLines = 1
        ellipsize = android.text.TextUtils.TruncateAt.END
        isFocusable = true
        isFocusableInTouchMode = true
        isClickable = true
        setPadding(Theme.dp(ctx, 16), Theme.dp(ctx, 12), Theme.dp(ctx, 16), Theme.dp(ctx, 12))
        background = Theme.focusBox(ctx, Theme.INK_900, Theme.FILL_2, Theme.LINE, Theme.BAMBOO_400, radiusDp = 10)
        setTextColor(android.content.res.ColorStateList(
            arrayOf(intArrayOf(android.R.attr.state_focused), intArrayOf(android.R.attr.state_selected), intArrayOf()),
            intArrayOf(Theme.PAPER_50, Theme.BAMBOO_400, Theme.PAPER_100),
        ))
        layoutParams = RecyclerView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
    }

    private fun showOverlay(focusTarget: View? = null) {
        if (panelMode != null) return
        val wasVisible = overlayVisible
        val controlsHaveFocus = topShade.hasFocus() || bottomShade.hasFocus() || upNextBox.hasFocus()
        val target = focusTarget ?: if (!wasVisible || !controlsHaveFocus) lastControl?.takeIf { it.visibility == View.VISIBLE } ?: playPauseBtn else null
        setOverlayVisible(true, focusTarget = target)
        scheduleIdleHide()
    }

    private fun setOverlayVisible(visible: Boolean, focusTarget: View? = if (visible) lastControl?.takeIf { it.visibility == View.VISIBLE } ?: playPauseBtn else null) {
        if (!visible && overlayVisible) lastControl = topShade.findFocus() ?: bottomShade.findFocus() ?: lastControl
        overlayVisible = visible
        val vis = if (visible) View.VISIBLE else View.GONE
        val wasVisible = bottomShade.visibility == View.VISIBLE
        topShade.visibility = vis
        bottomShade.visibility = vis
        if (visible) {
            if (!wasVisible) {
                Theme.reveal(topShade, -Theme.dp(ctx, 4))
                Theme.reveal(bottomShade, Theme.dp(ctx, 4))
            }
            focusTarget?.let { target ->
                target.post {
                    if (!destroyed && overlayVisible && panelMode == null && errorBox.visibility != View.VISIBLE && target.isShown && !target.hasFocus()) {
                        target.requestFocus()
                    }
                }
            }
            scheduleIdleHide()
        } else {
            idleJob?.cancel()
        }
    }

    private fun scheduleIdleHide() {
        idleJob?.cancel()
        idleJob = scope.launch {
            delay(Constants.PLAYER_IDLE_MS)
            if (!destroyed && overlayVisible && panelMode == null && errorBox.visibility != View.VISIBLE &&
                exoPlayer?.isPlaying == true && !userSeeking
            ) {
                setOverlayVisible(false)
            }
        }
    }

    private fun showOsd(icon: TvIcon, text: String) {
        if (!screenShown || panelMode != null || errorBox.visibility == View.VISIBLE) return
        osdIcon.setIcon(icon)
        osdTv.text = text
        osdBox.visibility = View.VISIBLE
        osdJob?.cancel()
        osdJob = scope.launch {
            delay(Constants.OSD_MS)
            if (!destroyed) osdBox.visibility = View.GONE
        }
    }

    companion object {
    }
}
