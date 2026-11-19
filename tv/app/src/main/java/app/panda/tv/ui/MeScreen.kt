package app.panda.tv.ui

import android.content.Context
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import androidx.recyclerview.widget.RecyclerView
import app.panda.tv.model.Copy
import app.panda.tv.model.HistoryEntry
import app.panda.tv.model.MediaItem
import app.panda.tv.model.MediaType
import app.panda.tv.model.Rules
import app.panda.tv.model.StateAction
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

class MeScreen(ctx: Context, nav: Navigator) : Screen(ctx, nav) {
    override val activeTab: String = "me"

    private val m = Theme.metrics(ctx)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val root = Theme.headerFirstColumn(ctx).apply {
        clipChildren = true
    }
    private val bodyBox = FrameLayout(ctx).apply {
        clipChildren = true
        clipToPadding = true
    }
    private val posterGrid = Theme.verticalGrid(ctx, bodyBox).apply {
        setHorizontalSpacing(m.gridGapH)
        setVerticalSpacing(m.gridGapV)
        setPadding(m.pageH, Theme.dp(ctx, 12), m.pageH, Theme.dp(ctx, 40))
        Theme.bindGridHeaderNavigation(this, columns = 6) { favTabBtn }
    }
    private val historyGrid = Theme.verticalGrid(ctx, bodyBox).apply {
        setHorizontalSpacing(m.wideGapH)
        setVerticalSpacing(m.gridGapV)
        setPadding(m.pageH, Theme.dp(ctx, 12), m.pageH, Theme.dp(ctx, 40))
        Theme.bindGridHeaderNavigation(this, columns = 4) { histTabBtn }
    }

    private var tab = "favorites"
    private lateinit var favTabBtn: LinearLayout
    private lateinit var histTabBtn: LinearLayout
    private lateinit var clearHistBtn: LinearLayout
    private var entries: List<Pair<MediaItem, HistoryEntry?>> = emptyList()
    private var loadJob: Job? = null
    private var destroyed = false
    private var requestedTab: String? = null
    private var requestedIds: List<String>? = null
    private var requestedHistory: List<HistoryEntry>? = null
    private val favAdapter = EntryAdapter(wideCards = false)
    private val histAdapter = EntryAdapter(wideCards = true)

    override val view: View get() = root

    init {
        buildBar()
        posterGrid.adapter = favAdapter
        historyGrid.adapter = histAdapter
        root.addView(bodyBox, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        refresh()
    }

    override fun onShown() {
        val state = nav.app.userStore.get()
        val ids = if (tab == "history") state.history.map { it.id } else state.favorites
        if (requestedTab != tab || requestedIds != ids || (tab == "history" && requestedHistory != state.history)) refresh()
    }

    override fun onDestroy() {
        destroyed = true
        loadJob?.cancel()
        scope.cancel()
    }

    private fun buildBar() {
        val upToTopBar = View.OnKeyListener { _, keyCode, event ->
            if (event.action == KeyEvent.ACTION_DOWN && keyCode == KeyEvent.KEYCODE_DPAD_UP) {
                nav.focusTopBar()
                true
            } else false
        }
        val bar = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(Theme.INK_950)
            clipChildren = false
            clipToPadding = false
            setPadding(m.pageH, Theme.dp(ctx, 12), m.pageH, Theme.dp(ctx, 10))
        }
        favTabBtn = Theme.pillButton(ctx, Copy.Me.FAVORITES, icon = TvIcon.HEART, padH = 18, padV = 8, sp = 14f).apply {
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                rightMargin = Theme.dp(ctx, 10)
            }
            setOnKeyListener(upToTopBar)
            setOnClickListener {
                if (tab != "favorites") {
                    tab = "favorites"
                    refresh()
                }
            }
        }
        histTabBtn = Theme.pillButton(ctx, Copy.Me.HISTORY, icon = TvIcon.HISTORY, padH = 18, padV = 8, sp = 14f).apply {
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                rightMargin = Theme.dp(ctx, 10)
            }
            setOnKeyListener(upToTopBar)
            setOnClickListener {
                if (tab != "history") {
                    tab = "history"
                    refresh()
                }
            }
        }
        clearHistBtn = Theme.pillButton(ctx, Copy.Action.CLEAR, danger = true, icon = TvIcon.TRASH, padH = 15, padV = 8, sp = 13.5f).apply {
            setOnKeyListener(upToTopBar)
            setOnClickListener {
                nav.confirm(Copy.Me.CLEAR_HISTORY_TITLE, Copy.Action.CLEAR, destructive = true) {
                    nav.app.userStore.dispatch(StateAction.ClearHistory)
                    nav.toast(Copy.Toast.CLEARED)
                    refresh()
                }
            }
        }
        bar.addView(favTabBtn)
        bar.addView(histTabBtn)
        bar.addView(View(ctx).apply { layoutParams = LinearLayout.LayoutParams(0, 1, 1f) })
        bar.addView(clearHistBtn)
        root.addView(bar)
    }

    private fun syncTabs() {
        Theme.setPillSelected(favTabBtn, tab == "favorites")
        Theme.setPillSelected(histTabBtn, tab == "history")
        clearHistBtn.visibility = if (tab == "history" && nav.app.userStore.get().history.isNotEmpty()) View.VISIBLE else View.GONE
    }

    private fun enrichEpisodes(item: MediaItem): MediaItem {
        if (item.episodes != null) return item
        val known = nav.app.playback.knownEpisodes(item.id) ?: return item
        return item.copy(episodes = known)
    }

    private fun refresh() {
        syncTabs()
        loadJob?.cancel()
        val isHistory = tab == "history"
        val state = nav.app.userStore.get()
        val ids = if (!isHistory) state.favorites else state.history.map { it.id }
        requestedTab = tab
        requestedIds = ids.toList()
        requestedHistory = if (isHistory) state.history.toList() else null
        if (ids.isEmpty()) {
            entries = emptyList()
            bodyBox.removeAllViews()
            bodyBox.addView(Theme.emptyOrErrorBox(ctx, if (!isHistory) Copy.Me.EMPTY_FAVORITES else Copy.Me.EMPTY_HISTORY))
            return
        }
        bodyBox.removeAllViews()
        bodyBox.addView(Theme.loadingBox(ctx))
        loadJob = scope.launch {
            try {
                val items = nav.app.douban.byIds(ids)
                if (destroyed) return@launch
                val byId = items.associateBy { it.id }
                val histById = state.history.associateBy { it.id }
                entries = ids.mapNotNull { id ->
                    val raw = byId[id] ?: return@mapNotNull null
                    val it = if (isHistory) enrichEpisodes(raw) else raw
                    it to (if (isHistory) histById[id] else null)
                }
                bodyBox.removeAllViews()
                if (entries.isEmpty()) {
                    bodyBox.addView(Theme.emptyOrErrorBox(ctx, if (!isHistory) Copy.Me.EMPTY_FAVORITES else Copy.Me.EMPTY_HISTORY))
                } else if (isHistory) {
                    histAdapter.notifyDataSetChanged()
                    bodyBox.addView(historyGrid, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

                    val unresolved = entries.map { it.first }.filter { it.episodes == null && it.type != MediaType.MOVIE }.take(6)
                    if (unresolved.isNotEmpty()) {
                        var updated = false
                        for (s in unresolved) {
                            val avail = runCatching {
                                nav.app.playback.availability(s, nav.app.douban.workHints(s.id))
                            }.getOrNull()
                            if (avail?.episodes != null) updated = true
                        }
                        if (!destroyed && tab == "history" && updated) {
                            entries = entries.map { (it, h) -> enrichEpisodes(it) to h }
                            histAdapter.notifyDataSetChanged()
                        }
                    }
                } else {
                    favAdapter.notifyDataSetChanged()
                    bodyBox.addView(posterGrid, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (t: Throwable) {
                if (!destroyed) {
                    requestedTab = null
                    bodyBox.removeAllViews()
                    bodyBox.addView(Theme.emptyOrErrorBox(ctx, Copy.errorText(t), Copy.Action.RETRY) { refresh() })
                }
            }
        }
    }

    private inner class EntryAdapter(private val wideCards: Boolean) : RecyclerView.Adapter<EntryAdapter.VH>() {
        init {
            setHasStableIds(true)
        }

        override fun getItemId(position: Int): Long = entries[position].first.id.hashCode().toLong()
        override fun getItemCount(): Int = entries.size
        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH = VH(MediaCardView(ctx, wide = wideCards))
        override fun onBindViewHolder(holder: VH, position: Int) {
            val (item, h) = entries[position]
            val sub = h?.let { Rules.progressText(item, it) }
            val pct = h?.let { Rules.progressPercent(it) }
            holder.card.bind(nav.app, item, sub, pct)
            holder.card.setOnClickListener {
                if (h != null) nav.openPlayer(item.id, h.episode) else nav.openDetail(item.id)
            }
            if (h != null) {
                holder.card.setOnLongClickListener {
                    promptRemoveHistory(item)
                    true
                }
                holder.card.setOnKeyListener { _, keyCode, event ->
                    if (event.action == KeyEvent.ACTION_DOWN && keyCode == KeyEvent.KEYCODE_MENU) {
                        promptRemoveHistory(item)
                        true
                    } else false
                }
            } else {
                holder.card.setOnLongClickListener(null)
                holder.card.setOnKeyListener(null)
            }
        }

        private fun promptRemoveHistory(item: MediaItem) {
            nav.confirm("${Copy.Action.REMOVE}「${item.title}」？", Copy.Action.REMOVE, destructive = true) {
                nav.app.userStore.dispatch(StateAction.RemoveHistory(item.id))
                nav.toast(Copy.Toast.REMOVED)
                refresh()
            }
        }

        inner class VH(val card: MediaCardView) : RecyclerView.ViewHolder(card)
    }
}
