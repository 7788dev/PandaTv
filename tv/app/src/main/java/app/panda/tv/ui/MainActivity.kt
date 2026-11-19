package app.panda.tv.ui

import android.app.Activity
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import app.panda.tv.PandaTvApp
import app.panda.tv.model.Copy
import app.panda.tv.model.MediaType
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.cancel
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout

class MainActivity : Activity(), Navigator {
    override lateinit var app: PandaTvApp
        private set

    private lateinit var rootLayout: FrameLayout
    private lateinit var mainCol: LinearLayout
    private lateinit var topBarWrap: LinearLayout
    private lateinit var contentFrame: FrameLayout
    private lateinit var toastView: TextView
    private var modalOverlay: View? = null

    private val navPills = LinkedHashMap<String, TextView>()
    private val stack = ArrayList<Screen>()
    private val handler = Handler(Looper.getMainLooper())
    private var toastHideRunnable: Runnable? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var playerCheckJob: Job? = null
    private var playerCheckOverlay: View? = null
    private var playerCheckTarget: Pair<String, Int>? = null
    private var playerCheckGeneration = 0L

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        app = application as PandaTvApp

        rootLayout = FrameLayout(this).apply {
            setBackgroundColor(Theme.INK_950)
        }
        mainCol = Theme.headerFirstColumn(this).apply {
            clipChildren = true
            layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        }
        topBarWrap = buildTopBar()
        contentFrame = FrameLayout(this).apply {
            clipChildren = true
            clipToPadding = true
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f)
        }
        mainCol.addView(topBarWrap)
        mainCol.addView(contentFrame)
        rootLayout.addView(mainCol)

        toastView = Theme.label(this, sp = 14f, color = Theme.PAPER_100, bold = true, maxLines = 2).apply {
            visibility = View.GONE
            maxWidth = Theme.dp(this@MainActivity, 560)
            setPadding(Theme.dp(this@MainActivity, 20), Theme.dp(this@MainActivity, 10), Theme.dp(this@MainActivity, 20), Theme.dp(this@MainActivity, 10))
            background = Theme.box(Theme.GLASS_STRONG, Theme.BAMBOO_LINE, radiusDp = 999, strokeDp = 1, ctx = this@MainActivity)
            layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL).apply {
                bottomMargin = Theme.dp(this@MainActivity, 36)
            }
        }
        rootLayout.addView(toastView)
        setContentView(rootLayout)

        openHome()
    }

    override fun onPause() {
        super.onPause()
        cancelPlayerCheck()
        stack.lastOrNull()?.onHidden()
        app.flushAll()
    }

    override fun onResume() {
        super.onResume()
        stack.lastOrNull()?.onShown()
    }

    override fun onDestroy() {
        super.onDestroy()
        cancelPlayerCheck()
        scope.cancel()
        toastHideRunnable?.let { handler.removeCallbacks(it) }
        for (s in stack.asReversed()) s.onDestroy()
        stack.clear()
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (playerCheckTarget != null && event.action == KeyEvent.ACTION_DOWN && event.keyCode == KeyEvent.KEYCODE_BACK) {
            cancelPlayerCheck()
            return true
        }
        if (modalOverlay != null) {
            if (event.action == KeyEvent.ACTION_DOWN && event.keyCode == KeyEvent.KEYCODE_BACK) {
                closeModal()
                return true
            }
            return super.dispatchKeyEvent(event)
        }
        if (stack.lastOrNull()?.dispatchRemoteKey(event) == true) return true
        return super.dispatchKeyEvent(event)
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (playerCheckTarget != null) {
            cancelPlayerCheck()
            return
        }
        if (modalOverlay != null) {
            closeModal()
            return
        }
        val top = stack.lastOrNull()
        if (top != null && top.onBackPressed()) return
        if (stack.size > 1) {
            back()
            return
        }
        if (top !is HomeScreen) {
            openHome()
            return
        }
        @Suppress("DEPRECATION")
        super.onBackPressed()
    }

    private fun buildTopBar(): LinearLayout {
        val m = Theme.metrics(this)
        val wrap = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Theme.INK_950)
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        }
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            clipChildren = false
            clipToPadding = false
            setPadding(m.pageH, Theme.dp(this@MainActivity, 11), m.pageH, Theme.dp(this@MainActivity, 9))
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, Theme.dp(this@MainActivity, 64))
        }

        val logo = PandaLogoView(this).apply {
            val sz = Theme.dp(this@MainActivity, 27)
            layoutParams = LinearLayout.LayoutParams(sz, sz).apply { rightMargin = Theme.dp(this@MainActivity, 9) }
        }
        val brand = Theme.label(this, Copy.App.NAME, sp = 18.5f, color = Theme.PAPER_100, bold = true).apply {
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                rightMargin = Theme.dp(this@MainActivity, 20)
            }
        }
        bar.addView(logo)
        bar.addView(brand)

        // Native TV OS floating capsule dock for primary navigation tabs
        val navDock = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            clipChildren = false
            clipToPadding = false
            val pad = Theme.dp(this@MainActivity, 4)
            setPadding(pad, pad, pad, pad)
            background = Theme.box(Theme.INK_900, Theme.LINE, radiusDp = 999, ctx = this@MainActivity)
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        }

        fun addTab(key: String, label: String, last: Boolean = false, onClick: () -> Unit) {
            val pill = Theme.navPill(this, label).apply {
                layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                    if (!last) rightMargin = Theme.dp(this@MainActivity, 2)
                }
                setOnClickListener { onClick() }
            }
            navPills[key] = pill
            navDock.addView(pill)
        }

        addTab("home", Copy.Nav.HOME) { openHome() }
        addTab("tv", Copy.Nav.TV) { openChannel(MediaType.TV) }
        addTab("movie", Copy.Nav.MOVIE) { openChannel(MediaType.MOVIE) }
        addTab("variety", Copy.Nav.VARIETY) { openChannel(MediaType.VARIETY) }
        addTab("anime", Copy.Nav.ANIME) { openChannel(MediaType.ANIME) }
        addTab("doc", Copy.Nav.DOC) { openChannel(MediaType.DOC) }
        addTab("me", Copy.Nav.ME, last = true) { openMe() }
        bar.addView(navDock)

        bar.addView(View(this).apply { layoutParams = LinearLayout.LayoutParams(0, 1, 1f) })

        val searchBtn = Theme.pillButton(this, Copy.Search.LABEL, icon = TvIcon.SEARCH, padH = 15, padV = 7, sp = 13.5f).apply {
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                rightMargin = Theme.dp(this@MainActivity, 10)
            }
            setOnClickListener { openSearch() }
        }
        val settingsBtn = Theme.pillButton(this, Copy.Nav.SETTINGS, icon = TvIcon.SETTINGS, padH = 15, padV = 7, sp = 13.5f).apply {
            setOnClickListener { openSettings() }
        }
        bar.addView(searchBtn)
        bar.addView(settingsBtn)
        wrap.addView(bar)
        return wrap
    }

    private fun animateScreenIn(v: View, rise: Boolean) {
        Theme.reveal(v, if (rise) Theme.dp(this, 4) else 0)
    }

    private fun replaceRoot(screen: Screen) {
        cancelPlayerCheck()
        val hadPrior = stack.isNotEmpty()
        stack.lastOrNull()?.onHidden()
        for (s in stack.asReversed()) s.onDestroy()
        stack.clear()
        contentFrame.removeAllViews()
        stack.add(screen)
        contentFrame.addView(screen.view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        syncChrome(screen)
        if (hadPrior) animateScreenIn(screen.view, rise = false)
        screen.onShown()
    }

    private fun pushScreen(screen: Screen) {
        cancelPlayerCheck()
        stack.lastOrNull()?.let { prev ->
            prev.lastFocused = currentFocus
            prev.onHidden()
        }
        stack.add(screen)
        contentFrame.removeAllViews()
        contentFrame.addView(screen.view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        syncChrome(screen)
        if (screen !is PlayerScreen) animateScreenIn(screen.view, rise = true)
        screen.onShown()
    }

    private fun syncChrome(screen: Screen) {
        topBarWrap.visibility = if (screen.showTopBar) View.VISIBLE else View.GONE
        for ((k, v) in navPills) {
            v.isSelected = (k == screen.activeTab)
        }
    }

    override fun openHome() {
        if (stack.size == 1 && stack[0] is HomeScreen) return
        replaceRoot(HomeScreen(this, this))
    }

    override fun openChannel(type: MediaType) {
        val top = stack.lastOrNull()
        if (stack.size == 1 && top is ChannelScreen && top.type == type) return
        replaceRoot(ChannelScreen(this, this, type))
    }

    override fun openMe() {
        if (stack.size == 1 && stack[0] is MeScreen) return
        replaceRoot(MeScreen(this, this))
    }

    override fun openSearch() {
        if (stack.lastOrNull() is SearchScreen) return
        pushScreen(SearchScreen(this, this))
    }

    override fun openSettings() {
        if (stack.lastOrNull() is SettingsScreen) return
        pushScreen(SettingsScreen(this, this))
    }

    override fun openDetail(id: String) {
        pushScreen(DetailScreen(this, this, id))
    }

    override fun openPerson(id: String, nameHint: String?, photoHint: String?) {
        pushScreen(PersonScreen(this, this, id, nameHint, photoHint))
    }

    override fun openPlayer(id: String, episode: Int) {
        if (playerCheckTarget == (id to episode)) return
        val origin = stack.lastOrNull() ?: return
        cancelPlayerCheck()
        val generation = playerCheckGeneration
        playerCheckTarget = id to episode
        val overlay = Theme.loadingBox(this, Copy.Extra.CHECKING_SOURCES).apply {
            setBackgroundColor(0x550E0D0B)
            isClickable = true
            isFocusable = false
        }
        playerCheckOverlay = overlay
        rootLayout.addView(overlay, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        playerCheckJob = scope.launch {
            try {
                val item = withTimeout(22_000L) {
                    val metadata = app.douban.detail(id)
                    app.playback.prepareItem(metadata, episode, app.douban.workHints(id))
                }
                coroutineContext.ensureActive()
                if (generation != playerCheckGeneration || stack.lastOrNull() !== origin) return@launch
                clearPlayerCheck()
                pushScreen(PlayerScreen(this@MainActivity, this@MainActivity, item, episode))
            } catch (timeout: TimeoutCancellationException) {
                if (generation == playerCheckGeneration) toast(Copy.Extra.TIMEOUT)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                if (generation == playerCheckGeneration) {
                    toast(if (error.message == Copy.Extra.SOURCE_UNAVAILABLE) Copy.Extra.NO_SOURCE_YET else Copy.errorText(error))
                }
            } finally {
                if (generation == playerCheckGeneration) clearPlayerCheck()
            }
        }
    }

    private fun clearPlayerCheck() {
        playerCheckOverlay?.let { rootLayout.removeView(it) }
        playerCheckOverlay = null
        playerCheckTarget = null
        playerCheckJob = null
    }

    private fun cancelPlayerCheck() {
        playerCheckGeneration++
        playerCheckJob?.cancel()
        clearPlayerCheck()
    }

    override fun back() {
        cancelPlayerCheck()
        if (stack.size <= 1) {
            openHome()
            return
        }
        val popped = stack.removeAt(stack.lastIndex)
        popped.onHidden()
        popped.onDestroy()
        contentFrame.removeAllViews()
        val prev = stack.last()
        prev.view.animate().cancel()
        prev.view.alpha = 1f
        prev.view.translationY = 0f
        contentFrame.addView(prev.view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        syncChrome(prev)
        prev.onShown()
        prev.view.post {
            if (prev.lastFocused?.isAttachedToWindow == true) {
                prev.lastFocused?.requestFocus()
            }
        }
    }

    override fun toast(text: String) {
        toastHideRunnable?.let { handler.removeCallbacks(it) }
        toastView.text = text
        toastView.visibility = View.VISIBLE
        toastView.animate().cancel()
        toastView.alpha = 0f
        toastView.animate().alpha(1f).setDuration(110L).setInterpolator(Theme.decelerate).start()
        val r = Runnable { toastView.visibility = View.GONE }
        toastHideRunnable = r
        handler.postDelayed(r, 2400L)
    }

    override fun confirm(title: String, confirmText: String, destructive: Boolean, onConfirm: () -> Unit) {
        closeModal()
        val m = Theme.metrics(this)
        val returnFocus = currentFocus
        val scrim = FrameLayout(this).apply {
            setBackgroundColor(Theme.SCRIM)
            isClickable = true
            isFocusable = false
        }
        val cardW = minOf(Theme.dp(this, 440), m.innerW)
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(Theme.dp(this@MainActivity, 28), Theme.dp(this@MainActivity, 26), Theme.dp(this@MainActivity, 28), Theme.dp(this@MainActivity, 24))
            background = Theme.box(Theme.GLASS_STRONG, Theme.LINE_2, radiusDp = 18, ctx = this@MainActivity)
            layoutParams = FrameLayout.LayoutParams(cardW, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER)
        }
        card.addView(Theme.label(this, title, sp = 17.5f, color = Theme.PAPER_100, bold = true, maxLines = 3).apply {
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                bottomMargin = Theme.dp(this@MainActivity, 22)
            }
        })
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.END
            clipChildren = false
        }
        val cancelBtn = Theme.pillButton(this, Copy.Action.CANCEL).apply {
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                rightMargin = Theme.dp(this@MainActivity, 12)
            }
            setOnClickListener {
                closeModal()
                returnFocus?.requestFocus()
            }
        }
        val okBtn = Theme.pillButton(this, confirmText, primary = !destructive, danger = destructive).apply {
            setOnClickListener {
                closeModal()
                onConfirm()
                returnFocus?.requestFocus()
            }
        }
        row.addView(cancelBtn)
        row.addView(okBtn)
        card.addView(row)
        scrim.addView(card)
        scrim.tag = returnFocus
        modalOverlay = scrim
        mainCol.descendantFocusability = ViewGroup.FOCUS_BLOCK_DESCENDANTS
        rootLayout.addView(scrim, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        card.alpha = 0f
        card.scaleX = 0.96f
        card.scaleY = 0.96f
        card.animate().alpha(1f).scaleX(1f).scaleY(1f).setDuration(120L).setInterpolator(Theme.decelerate).start()
        cancelBtn.post { cancelBtn.requestFocus() }
    }

    override fun focusTopBar() {
        val active = stack.lastOrNull()?.activeTab
        (navPills[active] ?: navPills["home"])?.requestFocus()
    }

    private fun closeModal() {
        val m = modalOverlay ?: return
        modalOverlay = null
        mainCol.descendantFocusability = ViewGroup.FOCUS_AFTER_DESCENDANTS
        rootLayout.removeView(m)
        (m.tag as? View)?.requestFocus()
    }
}
