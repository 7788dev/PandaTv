package app.panda.tv.ui

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
import androidx.media3.exoplayer.DecoderCounters
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
import app.panda.tv.playback.RemoteSeekTarget
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

@OptIn(UnstableApi::class)
class PlayerScreen(
    ctx: Context,
    nav: Navigator,
    initialItem: MediaItem,
    initialEpisode: Int,
) : Screen(ctx, nav) {
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
    private val osdBox = LinearLayout(ctx).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        visibility = View.GONE
        setPadding(Theme.dp(ctx, 22), Theme.dp(ctx, 11), Theme.dp(ctx, 22), Theme.dp(ctx, 11))
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
        setPadding(m.pageH, Theme.dp(ctx, 24), m.pageH, Theme.dp(ctx, 22))
        background = GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, intArrayOf(0xE00E0D0B.toInt(), Color.TRANSPARENT))
    }
    private val titleTv = Theme.label(ctx, sp = 20f, color = Theme.PAPER_100, bold = true, maxLines = 1)
    private val epTv = Theme.label(ctx, sp = 13.5f, color = Theme.PAPER_70, maxLines = 1)

    private val bottomShade = LinearLayout(ctx).apply {
        orientation = LinearLayout.VERTICAL
        clipChildren = false
        clipToPadding = false
        setPadding(m.pageH, Theme.dp(ctx, 24), m.pageH, Theme.dp(ctx, 26))
        background = GradientDrawable(GradientDrawable.Orientation.BOTTOM_TOP, intArrayOf(0xEB0E0D0B.toInt(), Color.TRANSPARENT))
    }
    private val seekBar = SeekBar(ctx).apply {
        max = 1000
        isFocusable = true
        isFocusableInTouchMode = true
        progressTintList = android.content.res.ColorStateList.valueOf(Theme.BAMBOO_400)
        thumbTintList = android.content.res.ColorStateList.valueOf(Theme.PAPER_50)
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

    private val sidePanel = LinearLayout(ctx).apply {
        orientation = LinearLayout.VERTICAL
        visibility = View.GONE
        clipChildren = false
        clipToPadding = false
        background = Theme.box(0xF7141311.toInt(), Theme.LINE, radiusDp = 0, strokeDp = 1, ctx = ctx)
        setPadding(Theme.dp(ctx, 24), Theme.dp(ctx, 28), Theme.dp(ctx, 24), Theme.dp(ctx, 28))
    }
    private val sideTitleTv = Theme.label(ctx, sp = 18f, color = Theme.PAPER_100, bold = true)
    private val sideGrid = Theme.verticalGrid(ctx, sidePanel).apply {
        setNumColumns(1)
        setVerticalSpacing(Theme.dp(ctx, 10))
        setPadding(Theme.dp(ctx, 4), Theme.dp(ctx, 6), Theme.dp(ctx, 4), Theme.dp(ctx, 12))
        clipToPadding = false
        clipChildren = false
        setOnKeyInterceptListener { event ->
            if (event.action != KeyEvent.ACTION_DOWN || panelMode == null) return@setOnKeyInterceptListener false
            when (event.keyCode) {
                // The panel is anchored to the right edge. Left exits it;
                // right must be consumed so focus never leaks back to the
                // video surface or the bottom controls behind the panel.
                KeyEvent.KEYCODE_DPAD_LEFT -> {
                    closePanel()
                    true
                }
                KeyEvent.KEYCODE_DPAD_RIGHT -> true
                else -> false
            }
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
    private var quality: Quality = sessionQuality ?: nav.app.userStore.get().settings.quality
    private var actualQuality: Quality? = null
    private var lastPanelAnchor: View? = null
    private var speed: Double = sessionSpeed ?: nav.app.userStore.get().settings.speed
    private var resumeAtSec: Double? = null
    private var startedPlayback = false
    private var playingEpisode: Int? = null
    private var loadGeneration = 0L
    private var screenShown = false
    private var playRequested = true
    private var sourceStarted = false
    private var lastProgressAt = System.currentTimeMillis()
    private var playingSince = 0L
    private var autoAttempts = 0
    private var autoAdvanced = false
    private var upNextCancelled = false
    private var preparedNext = false
    private var overlayVisible = true
    private var panelMode: String? = null // "episodes" | "lines" | null
    private var destroyed = false
    private var lastSavedAt = 0L
    private var userSeeking = false
    private var scrubbing = false
    private var pendingRemoteSeekMs: Long? = null
    private var speedMeasureJob: Job? = null
    private var speedMeasureGeneration = 0L
    private val speedMeasureProcessedFrames = AtomicInteger()
    private val speedMeasureDropped = AtomicInteger()
    private data class VideoFrameCounters(val rendered: Int, val dropped: Int)

    private var loadJob: Job? = null
    private var tickJob: Job? = null
    private var idleJob: Job? = null
    private var osdJob: Job? = null
    private var startupWatchJob: Job? = null
    private var preloadJob: Job? = null
    private var scrubbingOffJob: Job? = null

    override val view: View get() = root

    init {
        buildLayout()
        buildPlayer()
        loadAndStart(retry = false, fromSource = null)
    }

    override fun onHidden() {
        screenShown = false
        saveHistory()
        exoPlayer?.pause()
    }

    override fun onShown() {
        screenShown = true
        if (overlayVisible) showOverlay()
        exoPlayer?.let { p ->
            if (playRequested && playbackData != null && !p.isPlaying && errorBox.visibility != View.VISIBLE) {
                p.play()
            }
        }
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
        scrubbingOffJob?.cancel()
        speedMeasureJob?.cancel()
        scrubbing = false
        pendingRemoteSeekMs = null
        exoPlayer?.release()
        exoPlayer = null
        scope.cancel()
    }

    override fun onBackPressed(): Boolean {
        if (panelMode != null) {
            closePanel()
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
        if (event.action != KeyEvent.ACTION_DOWN) return false
        if (errorBox.visibility == View.VISIBLE || panelMode != null) return false

        when (event.keyCode) {
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE -> {
                togglePlayPause()
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
                seekRelative(Constants.SEEK_STEP_SECONDS, focusSeekBar = !overlayVisible)
                return true
            }
            KeyEvent.KEYCODE_MEDIA_REWIND -> {
                seekRelative(-Constants.SEEK_STEP_SECONDS, focusSeekBar = !overlayVisible)
                return true
            }
            KeyEvent.KEYCODE_MENU -> {
                setOverlayVisible(!overlayVisible)
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
                    seekRelative(-Constants.SEEK_STEP_SECONDS, focusSeekBar = true)
                    return true
                }
                KeyEvent.KEYCODE_DPAD_RIGHT -> {
                    seekRelative(Constants.SEEK_STEP_SECONDS, focusSeekBar = true)
                    return true
                }
                KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER -> {
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

        root.addView(centerSpinner, FrameLayout.LayoutParams(Theme.dp(ctx, 44), Theme.dp(ctx, 44), Gravity.CENTER))

        osdBox.addView(osdIcon)
        osdBox.addView(osdTv)
        root.addView(osdBox, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER))

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
            upNextBox.visibility = View.GONE
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
                    seekRelative(-Constants.SEEK_STEP_SECONDS, focusSeekBar = false)
                    true
                }
                KeyEvent.KEYCODE_DPAD_RIGHT -> {
                    seekRelative(Constants.SEEK_STEP_SECONDS, focusSeekBar = false)
                    true
                }
                KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER -> {
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
        episodesBtn.setOnClickListener { openPanel("episodes") }
        lineBtn.setOnClickListener { openPanel("lines") }
        qualityBtn.setOnClickListener { cycleQuality() }
        speedBtn.setOnClickListener { cycleSpeed() }

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
        root.addView(sidePanel, FrameLayout.LayoutParams(Theme.dp(ctx, 340), ViewGroup.LayoutParams.MATCH_PARENT, Gravity.END))

        root.addView(errorBox, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        surfaceView.setOnClickListener {
            if (panelMode != null) closePanel()
            else setOverlayVisible(!overlayVisible)
        }
    }

    private fun buildPlayer() {
        val maxMemMb = Runtime.getRuntime().maxMemory() / (1024L * 1024L)
        val lowRam = maxMemMb <= 192L
        val loadControl = DefaultLoadControl.Builder()
            .setBufferDurationsMs(if (lowRam) 10_000 else 12_000, if (lowRam) 30_000 else 48_000, 1_000, 2_000)
            .setTargetBufferBytes((if (lowRam) 16 else 32) * 1024 * 1024)
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
                if (speed != 1.0 && player.isPlaying) speedMeasureProcessedFrames.addAndGet(frameCount)
            }

            override fun onDroppedVideoFrames(eventTime: AnalyticsListener.EventTime, count: Int, elapsedMs: Long) {
                if (speed != 1.0) speedMeasureDropped.addAndGet(count)
            }
        })
        player.addListener(object : Player.Listener {
            private fun isCurrentMedia(): Boolean = !destroyed && playbackData != null &&
                player.currentMediaItem?.mediaId == "$itemId:$episode:$loadGeneration"

            override fun onVideoSizeChanged(videoSize: VideoSize) {
                if (!isCurrentMedia()) return
                lastVideoSize = videoSize
                adjustVideoAspect(videoSize)
            }

            override fun onRenderedFirstFrame() {
                if (isCurrentMedia()) videoShutter.visibility = View.GONE
            }

            override fun onPlaybackStateChanged(playbackState: Int) {
                if (!isCurrentMedia()) return
                lastProgressAt = System.currentTimeMillis()
                when (playbackState) {
                    Player.STATE_BUFFERING -> {
                        centerSpinner.visibility = View.VISIBLE
                    }
                    Player.STATE_READY -> {
                        centerSpinner.visibility = View.GONE
                        sourceStarted = true
                        startedPlayback = true
                        if (playingSince == 0L) playingSince = System.currentTimeMillis()
                        startupWatchJob?.cancel()
                        if (scrubbing) endScrubbingSoon()
                        syncButtons()
                        scheduleIdleHide()
                    }
                    Player.STATE_ENDED -> {
                        centerSpinner.visibility = View.GONE
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
                if (isPlaying && speed != 1.0) measureSpeedPlayback()
                syncButtons()
                if (!isPlaying && startedPlayback) saveHistory()
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

    private fun loadAndStart(retry: Boolean, fromSource: String?) {
        scrubbingOffJob?.cancel()
        scrubbing = false
        pendingRemoteSeekMs = null
        exoPlayer?.setScrubbingModeEnabled(false)
        saveHistory()
        val generation = ++loadGeneration
        val targetEpisode = episode
        val targetQuality = quality
        val targetResume = resumeAtSec
        resumeAtSec = null
        loadJob?.cancel()
        startupWatchJob?.cancel()
        preloadJob?.cancel()
        idleJob?.cancel()
        osdJob?.cancel()
        // Retire the old episode before any network work or mutable heading change.
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
        upNextBox.visibility = View.GONE
        osdBox.visibility = View.GONE
        errorBox.visibility = View.GONE
        showOverlay()
        centerSpinner.visibility = View.VISIBLE
        preparedNext = false
        autoAdvanced = false
        upNextCancelled = false
        playingSince = 0L
        mediaItem?.let { updateHeader(it) }
        syncButtons()

        loadJob = scope.launch {
            try {
                val item = mediaItem ?: return@launch
                val hints = nav.app.douban.workHints(item.id)

                var pb: Playback? = null
                var lastErr: Throwable? = null
                val maxTries = if (retry || fromSource != null) 1 else 3
                for (attempt in 0 until maxTries) {
                    try {
                        pb = nav.app.playback.resolve(item, targetEpisode, targetQuality, retry = retry, hints = hints, from = fromSource)
                        break
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (t: Throwable) {
                        lastErr = t
                        val msg = t.message.orEmpty()
                        val finalAnswer = msg in listOf(
                            Copy.Extra.SOURCE_UNAVAILABLE, Copy.Extra.NO_EPISODE,
                            Copy.Extra.NOT_FOUND, Copy.Extra.INVALID_INPUT, Copy.Extra.UNSUPPORTED_PLAYBACK,
                        )
                        if (finalAnswer || attempt == maxTries - 1) break
                        delay(800L)
                    }
                }
                val resolved = pb ?: throw (lastErr ?: IllegalStateException(Copy.Extra.PLAYER_RETRY))
                coroutineContext.ensureActive()
                if (destroyed || generation != loadGeneration) return@launch
                playbackData = resolved
                startExoPlayer(item, resolved, targetEpisode, targetResume, generation)

                launch {
                    val srcs = runCatching { nav.app.playback.sources(item, targetEpisode, hints) }.getOrNull()
                    coroutineContext.ensureActive()
                    if (!destroyed && generation == loadGeneration && srcs != null) {
                        playSources = srcs
                        syncButtons()
                    }
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (t: Throwable) {
                if (!destroyed && generation == loadGeneration) showError(t)
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
        val m3Item = Media3Item.Builder().setUri(pb.url).setMediaId("$itemId:$targetEpisode:$generation").build()
        val source = if (pb.format == "hls") {
            HlsMediaSource.Factory(dsFactory).createMediaSource(m3Item)
        } else {
            ProgressiveMediaSource.Factory(dsFactory).createMediaSource(m3Item)
        }
        playingEpisode = targetEpisode
        player.setMediaSource(source, (startSec * 1000.0).toLong().coerceAtLeast(0L))
        player.prepare()
        player.playWhenReady = screenShown && playRequested
        lastProgressAt = System.currentTimeMillis()
        syncButtons()

        startupWatchJob?.cancel()
        startupWatchJob = scope.launch {
            delay(15_000L)
            if (!destroyed && generation == loadGeneration && !sourceStarted && errorBox.visibility != View.VISIBLE) {
                handlePlaybackFailure(IllegalStateException("startup timeout"))
            }
        }
    }

    private fun handlePlaybackFailure(cause: Throwable) {
        if (destroyed) return
        scrubbingOffJob?.cancel()
        scrubbing = false
        pendingRemoteSeekMs = null
        exoPlayer?.setScrubbingModeEnabled(false)
        saveHistory()
        val p = exoPlayer
        if (p != null && p.currentPosition > 0L) resumeAtSec = p.currentPosition / 1000.0
        if (autoAttempts < 2) {
            autoAttempts++
            showOsd(TvIcon.REFRESH, Copy.Extra.RESTORING_SOURCE)
            loadAndStart(retry = true, fromSource = null)
        } else {
            showError(IllegalStateException(Copy.Extra.PLAYER_RETRY, cause))
        }
    }

    private fun showError(t: Throwable) {
        startedPlayback = false
        sourceStarted = false
        videoShutter.visibility = View.VISIBLE
        exoPlayer?.pause()
        exoPlayer?.stop()
        exoPlayer?.clearMediaItems()
        centerSpinner.visibility = View.GONE
        panelMode = null
        sidePanel.visibility = View.GONE
        topShade.visibility = View.GONE
        bottomShade.visibility = View.GONE
        topShade.descendantFocusability = ViewGroup.FOCUS_AFTER_DESCENDANTS
        bottomShade.descendantFocusability = ViewGroup.FOCUS_AFTER_DESCENDANTS
        errorBox.removeAllViews()
        val msg = Copy.errorText(t)
        val box = Theme.emptyOrErrorBox(ctx, msg, Copy.Action.RETRY) {
            autoAttempts = 0
            loadAndStart(retry = true, fromSource = null)
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
        val firstFocusable = (0 until box.childCount).map { box.getChildAt(it) }.firstOrNull { it.isFocusable }
        (firstFocusable ?: box).post { (firstFocusable ?: box).requestFocus() }
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
                if (p.isPlaying) {
                    lastProgressAt = System.currentTimeMillis()
                    if (autoAttempts > 0 && playingSince > 0L && System.currentTimeMillis() - playingSince > 60_000L) {
                        autoAttempts = 0
                    }
                } else if (sourceStarted && p.playWhenReady && p.playbackState == Player.STATE_BUFFERING &&
                    System.currentTimeMillis() - lastProgressAt > 20_000L
                ) {
                    lastProgressAt = System.currentTimeMillis()
                    handlePlaybackFailure(IllegalStateException("stall timeout"))
                    continue
                }

                if (durMs > 0L && !userSeeking) {
                    seekBar.progress = ((posMs * 1000L) / durMs).toInt().coerceIn(0, 1000)
                    seekBar.secondaryProgress = ((p.bufferedPosition * 1000L) / durMs).toInt().coerceIn(0, 1000)
                    val posSec = posMs / 1000.0
                    val durSec = durMs / 1000.0
                    timeTv.text = "${Rules.clock(posSec)} / ${Rules.clock(durSec)}"

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
                    val end = Rules.endPosition(playbackData, durSec, settings)
                    val up = Rules.upNextSeconds(posSec, end, hasNextEpisode(), settings.autoNext, upNextCancelled)
                    if (up != null && panelMode == null) {
                        val wasGone = upNextBox.visibility != View.VISIBLE
                        upNextBox.visibility = View.VISIBLE
                        upNextLabelTv.text = Copy.fmt(Copy.Player.UP_NEXT, "n" to up)
                        upNextTitleTv.text = mediaItem?.let { Rules.episodeHeading(it, episode + 1) } ?: ""
                        if (wasGone && !overlayVisible) {
                            upNextPlayBtn.post { upNextPlayBtn.requestFocus() }
                        }
                    } else {
                        upNextBox.visibility = View.GONE
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
        val playing = exoPlayer?.isPlaying == true
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

        val srcs = playSources
        lineBtn.visibility = if (srcs != null && srcs.list.size > 1) View.VISIBLE else View.GONE
        val curName = srcs?.list?.firstOrNull { it.key == srcs.current }?.name
        (lineBtn.getChildAt(1) as? TextView)?.text = if (curName != null) "${Copy.Extra.LINE}: $curName" else Copy.Extra.LINE
    }

    private fun togglePlayPause() {
        val p = exoPlayer ?: return
        if (p.isPlaying || (playbackData == null && playRequested)) {
            playRequested = false
            p.pause()
            showOsd(TvIcon.PAUSE, Copy.Player.PAUSE)
        } else {
            playRequested = true
            p.play()
            showOsd(TvIcon.PLAY, Copy.Player.PLAY)
        }
    }

    private fun seekRelative(deltaSec: Int, focusSeekBar: Boolean) {
        val p = exoPlayer ?: return
        val dur = p.duration
        if (dur <= 0L) return
        val target = RemoteSeekTarget.relative(p.currentPosition, pendingRemoteSeekMs, deltaSec * 1000L, dur) ?: return
        pendingRemoteSeekMs = target
        beginScrubbing()
        p.seekTo(target)
        endScrubbingSoon()
        seekBar.progress = ((target * 1000L) / dur).toInt().coerceIn(0, 1000)
        timeTv.text = "${Rules.clock(target / 1000.0)} / ${Rules.clock(dur / 1000.0)}"
        showOsd(
            if (deltaSec >= 0) TvIcon.FORWARD else TvIcon.REWIND,
            Copy.fmt(Copy.Player.SECONDS, "n" to kotlin.math.abs(deltaSec)),
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

    private fun cycleSpeed() {
        val idx = Constants.SPEEDS.indexOf(speed)
        speed = Constants.SPEEDS[(idx + 1) % Constants.SPEEDS.size]
        sessionSpeed = speed
        exoPlayer?.let { it.setPlaybackParameters(it.playbackParameters.withSpeed(speed.toFloat())) }
        measureSpeedPlayback()
        syncButtons()
        showOsd(TvIcon.SPEED, Rules.speedLabel(speed))
        scheduleIdleHide()
    }

    /** Record renderer frame and dropped-frame counters for ten seconds after a speed change. */
    private fun measureSpeedPlayback() {
        speedMeasureJob?.cancel()
        val generation = ++speedMeasureGeneration
        speedMeasureProcessedFrames.set(0)
        speedMeasureDropped.set(0)
        if (speed == 1.0) return
        val player = exoPlayer ?: return
        if (!player.isPlaying) return
        val measuredSpeed = speed
        val initialCounters = readVideoFrameCounters(player)
        val startedAt = android.os.SystemClock.elapsedRealtime()
        speedMeasureJob = scope.launch {
            delay(10_000L)
            if (!destroyed && generation == speedMeasureGeneration && speed == measuredSpeed) {
                val elapsed = android.os.SystemClock.elapsedRealtime() - startedAt
                val finalCounters = readVideoFrameCounters(player)
                val rendered = if (initialCounters != null && finalCounters != null) {
                    (finalCounters.rendered - initialCounters.rendered).coerceAtLeast(0)
                } else 0
                val dropped = if (initialCounters != null && finalCounters != null) {
                    (finalCounters.dropped - initialCounters.dropped).coerceAtLeast(0)
                } else 0
                val offsetSamples = speedMeasureProcessedFrames.get()
                Log.i("PandaTV", "[speed] rate=${measuredSpeed}x elapsedMs=$elapsed renderedFrames=$rendered droppedFrames=$dropped offsetSamples=$offsetSamples")
            }
        }
    }

    private fun readVideoFrameCounters(player: ExoPlayer): VideoFrameCounters? {
        for (index in 0 until player.rendererCount) {
            if (player.getRendererType(index) != C.TRACK_TYPE_VIDEO) continue
            val renderer = player.getRenderer(index)
            var owner: Class<*>? = renderer.javaClass
            while (owner != null) {
                val field = runCatching { owner.getDeclaredField("decoderCounters") }.getOrNull()
                if (field != null) {
                    val counters = runCatching {
                        field.isAccessible = true
                        field.get(renderer) as? DecoderCounters
                    }.getOrNull() ?: return null
                    counters.ensureUpdated()
                    return VideoFrameCounters(counters.renderedOutputBufferCount, counters.droppedBufferCount)
                }
                owner = owner.superclass
            }
        }
        return null
    }

    private fun cycleQuality() {
        val qs = playbackData?.qualities?.takeIf { it.isNotEmpty() } ?: Constants.QUALITIES
        val idx = qs.indexOf(quality)
        quality = qs[(idx + 1) % qs.size]
        sessionQuality = quality
        exoPlayer?.let { if (it.currentPosition > 0L) resumeAtSec = it.currentPosition / 1000.0 }
        loadAndStart(retry = false, fromSource = null)
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
        nav.app.userStore.dispatch(StateAction.RecordHistory(entry))
    }

    private fun openPanel(mode: String) {
        panelMode = mode
        lastPanelAnchor = if (mode == "episodes") episodesBtn else lineBtn
        setOverlayVisible(true)
        idleJob?.cancel()
        topShade.descendantFocusability = ViewGroup.FOCUS_BLOCK_DESCENDANTS
        bottomShade.descendantFocusability = ViewGroup.FOCUS_BLOCK_DESCENDANTS
        sidePanel.animate().cancel()
        sidePanel.visibility = View.VISIBLE
        sidePanel.alpha = 0f
        sidePanel.translationX = Theme.dp(ctx, 24).toFloat()
        sidePanel.animate()
            .alpha(1f)
            .translationX(0f)
            .setDuration(140L)
            .setInterpolator(Theme.decelerate)
            .start()
        if (mode == "episodes") {
            sideTitleTv.text = Copy.Player.EPISODES
            val item = mediaItem ?: return
            val count = item.episodes ?: 1
            sideGrid.adapter = object : RecyclerView.Adapter<RecyclerView.ViewHolder>() {
                override fun getItemCount(): Int = count
                override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder =
                    object : RecyclerView.ViewHolder(panelRowView()) {}

                override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
                    val ep = position + 1
                    val tv = holder.itemView as TextView
                    val title = item.episodeTitles?.getOrNull(ep - 1)
                    val active = ep == episode
                    tv.text = if (!title.isNullOrEmpty()) "${Rules.episodeLabel(item, ep)} · $title" else Rules.episodeLabel(item, ep)
                    tv.isSelected = active
                    tv.setTextColor(
                        android.content.res.ColorStateList(
                            arrayOf(intArrayOf(android.R.attr.state_focused), intArrayOf(android.R.attr.state_selected), intArrayOf()),
                            intArrayOf(Theme.PAPER_50, Theme.BAMBOO_400, Theme.PAPER_100),
                        )
                    )
                    tv.setOnClickListener {
                        if (ep != episode) {
                            selectEpisode(ep)
                        } else {
                            closePanel()
                        }
                    }
                }
            }
            val targetIdx = (episode - 1).coerceAtLeast(0)
            sideGrid.post {
                sideGrid.setSelectedPosition(targetIdx)
                sideGrid.requestFocus()
            }
        } else {
            sideTitleTv.text = Copy.Extra.LINE
            val srcs = playSources ?: return
            sideGrid.adapter = object : RecyclerView.Adapter<RecyclerView.ViewHolder>() {
                override fun getItemCount(): Int = srcs.list.size
                override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder =
                    object : RecyclerView.ViewHolder(panelRowView()) {}

                override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
                    val opt = srcs.list[position]
                    val tv = holder.itemView as TextView
                    val active = opt.key == srcs.current
                    tv.text = if (active) "${opt.name} ✓" else opt.name
                    tv.isSelected = active
                    tv.setTextColor(
                        android.content.res.ColorStateList(
                            arrayOf(intArrayOf(android.R.attr.state_focused), intArrayOf(android.R.attr.state_selected), intArrayOf()),
                            intArrayOf(Theme.PAPER_50, Theme.BAMBOO_400, Theme.PAPER_100),
                        )
                    )
                    tv.setOnClickListener {
                        closePanel()
                        if (!active) {
                            exoPlayer?.let { if (it.currentPosition > 0L) resumeAtSec = it.currentPosition / 1000.0 }
                            showOsd(TvIcon.REFRESH, Copy.Extra.SWITCHING_LINE)
                            autoAttempts = 0
                            loadAndStart(retry = false, fromSource = opt.key)
                        }
                    }
                }
            }
            val targetIdx = srcs.list.indexOfFirst { it.key == srcs.current }.coerceAtLeast(0)
            sideGrid.post {
                sideGrid.setSelectedPosition(targetIdx)
                sideGrid.requestFocus()
            }
        }
    }

    private fun closePanel() {
        if (panelMode == null) return
        panelMode = null
        sidePanel.animate().cancel()
        sidePanel.visibility = View.GONE
        sidePanel.alpha = 1f
        sidePanel.translationX = 0f
        topShade.descendantFocusability = ViewGroup.FOCUS_AFTER_DESCENDANTS
        bottomShade.descendantFocusability = ViewGroup.FOCUS_AFTER_DESCENDANTS
        val restore = lastPanelAnchor?.takeIf { it.visibility == View.VISIBLE } ?: playPauseBtn
        restore.post {
            if (!destroyed && panelMode == null && overlayVisible && restore.visibility == View.VISIBLE) restore.requestFocus()
        }
        scheduleIdleHide()
    }

    private fun panelRowView(): TextView = TextView(ctx).apply {
        setTextSize(TypedValue.COMPLEX_UNIT_PX, 14f * Theme.unit(ctx))
        maxLines = 1
        ellipsize = android.text.TextUtils.TruncateAt.END
        isFocusable = true
        isFocusableInTouchMode = true
        isClickable = true
        setPadding(Theme.dp(ctx, 16), Theme.dp(ctx, 11), Theme.dp(ctx, 16), Theme.dp(ctx, 11))
        background = Theme.focusBox(ctx, Theme.INK_900, Theme.FILL_2, Theme.LINE, Theme.BAMBOO_400, radiusDp = 10)
        layoutParams = RecyclerView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
    }

    private fun showOverlay(focusTarget: View? = null) {
        val wasVisible = overlayVisible
        val controlsHaveFocus = topShade.hasFocus() || bottomShade.hasFocus() || upNextBox.hasFocus()
        val target = focusTarget ?: if (!wasVisible || !controlsHaveFocus) playPauseBtn else null
        setOverlayVisible(true, focusTarget = target)
        scheduleIdleHide()
    }

    private fun setOverlayVisible(visible: Boolean, focusTarget: View? = if (visible) playPauseBtn else null) {
        overlayVisible = visible
        val vis = if (visible) View.VISIBLE else View.GONE
        topShade.visibility = vis
        bottomShade.visibility = vis
        if (visible) {
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
        private var sessionQuality: Quality? = null
        private var sessionSpeed: Double? = null
    }
}
