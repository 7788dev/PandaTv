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
import app.panda.tv.data.DataError
import app.panda.tv.data.LibraryFailure
import app.panda.tv.data.LibraryPage
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.ensureActive

class MeScreen(ctx: Context, nav: Navigator, initialTab: String? = null) : Screen(ctx, nav) {
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
        Theme.bindGridHeaderNavigation(this, columns = 6, onReachEnd = ::onGridEnd) { favTabBtn }
    }
    private val historyGrid = Theme.verticalGrid(ctx, bodyBox).apply {
        setHorizontalSpacing(m.wideGapH)
        setVerticalSpacing(m.gridGapV)
        setPadding(m.pageH, Theme.dp(ctx, 12), m.pageH, Theme.dp(ctx, 40))
        Theme.bindGridHeaderNavigation(this, columns = 4, onReachEnd = ::onGridEnd) { histTabBtn }
    }

    private var tab = if (initialTab == "history") "history" else "favorites"
    override fun saveRoute() = super.saveRoute().apply { putString("tab", tab) }
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
    private val pageFooter = PosterPageFooter(ctx, posterGrid) { retryFailedOrPage() }
    private val records = LinkedHashMap<String, MediaItem>()
    private val failures = LinkedHashMap<String, LibraryFailure>()
    private var nextCursor: String? = null
    private var initialLoaded = false
    private var loading = false
    private var pageError: Throwable? = null
    private var generation = 0L
    private var resumePage = false

    override val view: View get() = root

    init {
        buildBar()
        posterGrid.adapter = favAdapter
        historyGrid.adapter = histAdapter
        root.addView(bodyBox, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        root.addView(pageFooter)
        refresh()
    }

    override fun onShown() {
        val state = nav.app.userStore.get()
        val ids = if (tab == "history") state.history.map { it.id } else state.favorites
        if (requestedTab != tab || requestedIds != ids || (tab == "history" && requestedHistory != state.history)) refresh()
        else if (!loading && pageError == null && (!initialLoaded || resumePage)) loadPage()
    }

    override fun onHidden() { resumePage = loading; generation++; loadJob?.cancel(); loading = false }

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
                    nav.saveUser(StateAction.ClearHistory) {
                        nav.toast(Copy.Toast.CLEARED)
                        if (!destroyed) refresh()
                    }
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
        val interrupted = loading
        loadJob?.cancel()
        val isHistory = tab == "history"
        val state = nav.app.userStore.get()
        val ids = if (!isHistory) state.favorites else state.history.map { it.id }
        val changed = requestedTab != tab || requestedIds != ids
        requestedTab = tab
        requestedIds = ids.toList()
        requestedHistory = if (isHistory) state.history.toList() else null
        generation++
        loading = false
        pageFooter.bindGrid(if (isHistory) historyGrid else posterGrid)
        if (changed) {
            records.clear(); failures.clear(); entries = emptyList()
            nextCursor = null; initialLoaded = false; pageError = null
            favAdapter.notifyDataSetChanged(); histAdapter.notifyDataSetChanged()
            resumePage = false
        }
        if (ids.isEmpty()) {
            entries = emptyList()
            bodyBox.removeAllViews()
            bodyBox.addView(Theme.emptyOrErrorBox(ctx, if (!isHistory) Copy.Me.EMPTY_FAVORITES else Copy.Me.EMPTY_HISTORY))
            pageFooter.show()
            return
        }
        publishEntries()
        if (changed || interrupted || resumePage || !initialLoaded || pageError != null) loadPage()
    }

    private fun onGridEnd(position: Int, isNewPress: Boolean) {
        pageFooter.onGridEnd(position, isNewPress) { if (nextCursor != null) loadPage() else syncFooter() }
    }

    private fun retryFailedOrPage() {
        val id = requestedIds?.firstOrNull { failures.containsKey(it) }
        loadPage(id)
    }

    private fun syncFooter() {
        val first = requestedIds?.firstOrNull { failures.containsKey(it) }?.let { failures[it] }
        when {
            loading -> pageFooter.show(Copy.Channel.LOADING_MORE)
            first != null -> pageFooter.show("${Copy.fmt(Copy.Extra.LIBRARY_ITEM, "index" to ((requestedIds?.indexOf(first.id) ?: 0) + 1))} · ${Copy.errorText(DataError(first.code, "Library item"))}", retryable = true)
            pageError != null -> pageFooter.show(Copy.errorText(pageError), retryable = true)
            nextCursor == null && initialLoaded -> pageFooter.show(Copy.Channel.END)
            else -> pageFooter.show()
        }
        pageFooter.showMore(if (nextCursor != null && !loading) ({ loadPage() }) else null)
    }

    private fun merge(page: LibraryPage) {
        page.items.forEach { records[it.id] = it; failures.remove(it.id) }
        page.failures.forEach { failures[it.id] = it }
        publishEntries()
    }

    private fun publishEntries() {
        val ids = requestedIds.orEmpty()
        val history = requestedHistory.orEmpty().associateBy { it.id }
        val previous = entries
        entries = ids.mapNotNull { id -> records[id]?.let { enrichEpisodes(it) to history[id] } }
        val grid = if (tab == "history") historyGrid else posterGrid
        val adapter = if (tab == "history") histAdapter else favAdapter
        if (entries.isNotEmpty()) {
            if (grid.parent !== bodyBox) {
                bodyBox.removeAllViews()
                bodyBox.addView(grid, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            }
            val currentIds = previous.map { it.first.id }.toMutableList()
            for (position in entries.indices) {
                val id = entries[position].first.id
                if (currentIds.getOrNull(position) == id) {
                    if (previous.getOrNull(position) != entries[position]) adapter.notifyItemChanged(position)
                } else {
                    val old = currentIds.indexOf(id)
                    if (old >= 0) { currentIds.removeAt(old); currentIds.add(position, id); adapter.notifyItemMoved(old, position) }
                    else { currentIds.add(position, id); adapter.notifyItemInserted(position) }
                }
            }
            while (currentIds.size > entries.size) { val at = currentIds.lastIndex; currentIds.removeAt(at); adapter.notifyItemRemoved(at) }
        } else {
            bodyBox.removeAllViews()
            val first = ids.firstOrNull { failures.containsKey(it) }?.let { failures[it] }
            if (first != null || pageError != null) {
                val message = first?.let { "${Copy.fmt(Copy.Extra.LIBRARY_ITEM, "index" to (ids.indexOf(it.id) + 1))} · ${Copy.errorText(DataError(it.code, "Library item"))}" } ?: Copy.errorText(pageError)
                val box = Theme.emptyOrErrorBox(ctx, message, Copy.Action.RETRY) { retryFailedOrPage() }
                if (nextCursor != null) box.addView(Theme.pillButton(ctx, Copy.Extra.LOAD_MORE).apply { setOnClickListener { loadPage() } })
                bodyBox.addView(box)
            } else bodyBox.addView(Theme.loadingBox(ctx))
        }
        syncFooter()
        if (entries.isEmpty()) pageFooter.visibility = View.GONE
    }

    private fun loadPage(retryId: String? = null) {
        if (loading || destroyed) return
        val ids = requestedIds.orEmpty()
        if (ids.isEmpty() || (retryId == null && initialLoaded && nextCursor == null && pageError == null)) return
        loading = true; pageError = null; resumePage = false
        val at = ++generation
        syncFooter()
        loadJob = scope.launch {
            try {
                val cached = if (retryId == null) nav.app.douban.libraryPage(ids, nextCursor, cachedOnly = true) else null
                coroutineContext.ensureActive()
                if (destroyed || generation != at) return@launch
                if (cached != null) merge(cached)
                val pending = if (retryId != null) listOf(retryId) else cached!!.pending
                for (group in pending.chunked(6)) {
                    val loaded = nav.app.douban.libraryPage(group)
                    coroutineContext.ensureActive()
                    if (destroyed || generation != at) return@launch
                    merge(loaded)
                }
                if (cached != null) { nextCursor = cached.next; initialLoaded = true }
                loading = false
                publishEntries()
                if (tab == "history") {
                    val unresolved = entries.map { it.first }.filter { it.episodes == null && it.type != MediaType.MOVIE }.take(6)
                    for (item in unresolved) {
                        runCatching { nav.app.playback.availability(item, nav.app.douban.workHints(item.id)) }
                        coroutineContext.ensureActive()
                        if (destroyed || generation != at) return@launch
                        publishEntries()
                    }
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (t: Throwable) {
                if (!destroyed) {
                    if (generation == at) { loading = false; pageError = t; publishEntries() }
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
                nav.saveUser(StateAction.RemoveHistory(item.id)) {
                    nav.toast(Copy.Toast.REMOVED)
                    if (!destroyed) refresh()
                }
            }
        }

        inner class VH(val card: MediaCardView) : RecyclerView.ViewHolder(card)
    }
}
