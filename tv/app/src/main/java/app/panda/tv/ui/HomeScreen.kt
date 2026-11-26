package app.panda.tv.ui

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Color
import android.graphics.Rect
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.provider.Settings
import android.view.FocusFinder
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.RecyclerView
import app.panda.tv.R
import app.panda.tv.model.Copy
import app.panda.tv.model.HistoryEntry
import app.panda.tv.model.HomeFeed
import app.panda.tv.model.MediaItem
import app.panda.tv.model.MediaType
import app.panda.tv.model.RankBoard
import app.panda.tv.model.Rules
import app.panda.tv.model.Shelf
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch

class HomeScreen(ctx: Context, nav: Navigator, saved: android.os.Bundle? = null) : Screen(ctx, nav) {
    override val activeTab: String = "home"

    private val m = Theme.metrics(ctx)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val container = FrameLayout(ctx).apply {
        clipChildren = true
        clipToPadding = true
        setBackgroundColor(Theme.INK_950)
    }
    private val posterPool = RecyclerView.RecycledViewPool().apply { setMaxRecycledViews(0, 18) }
    private val widePool = RecyclerView.RecycledViewPool().apply { setMaxRecycledViews(1, 12) }

    private val homeList = Theme.homeVerticalList(ctx, container).apply {
        setVerticalSpacing(Theme.dp(ctx, 26))
        setPadding(0, Theme.dp(ctx, 8), 0, Theme.dp(ctx, 44))
        setOnKeyInterceptListener { event ->
            val direction = when (event.keyCode) {
                KeyEvent.KEYCODE_DPAD_LEFT -> View.FOCUS_LEFT
                KeyEvent.KEYCODE_DPAD_RIGHT -> View.FOCUS_RIGHT
                else -> return@setOnKeyInterceptListener false
            }
            if (event.action != KeyEvent.ACTION_DOWN) return@setOnKeyInterceptListener false
            val focused = findFocus() ?: return@setOnKeyInterceptListener false
            val holder = findContainingViewHolder(focused)
            if (holder !is RankViewHolder) return@setOnKeyInterceptListener false
            // At a board's horizontal edge, global geometric focus can choose
            // a top-bar button instead of staying in the visible rank row.
            FocusFinder.getInstance().findNextFocus(holder.itemView as ViewGroup, focused, direction)?.requestFocus(direction)
            true
        }
        setOnUnhandledKeyListener { event ->
            if (event.action == KeyEvent.ACTION_DOWN && event.keyCode == KeyEvent.KEYCODE_DPAD_UP && selectedPosition == 0) {
                nav.focusTopBar()
                true
            } else false
        }
    }

    private val homeAdapter = HomeAdapter()
    private var feed: HomeFeed? = null
    private var continuePairs: List<Pair<MediaItem, HistoryEntry>> = emptyList()
    private var heroIndex = saved?.getInt("hero") ?: 0
    private var heroId = saved?.getString("heroId")
    private var restoreShelf = saved?.getString("shelf")
    private var lastShelf: String? = null

    override fun saveRoute() = super.saveRoute().apply {
        putString("shelf", restoreShelf ?: if (visible) homeAdapter.keyAt(homeList.selectedPosition) else lastShelf)
        putInt("hero", heroIndex)
        putString("heroId", heroId)
    }
    private var loadJob: Job? = null
    private var continueJob: Job? = null
    private var heroAutoJob: Job? = null
    private var visible = false
    private var destroyed = false
    private var activeHeroHolder: HeroViewHolder? = null

    override val view: View get() = container

    init {
        homeList.adapter = homeAdapter
        load()
    }

    override fun onShown() {
        visible = true
        if (feed != null) refreshContinue()
        startHeroAutoCycle()
    }

    override fun onHidden() {
        if (visible) lastShelf = homeAdapter.keyAt(homeList.selectedPosition) ?: lastShelf
        visible = false
        heroAutoJob?.cancel()
        continueJob?.cancel()
    }

    override fun onDestroy() {
        destroyed = true
        visible = false
        heroAutoJob?.cancel()
        loadJob?.cancel()
        scope.cancel()
    }

    private fun animationsEnabled(): Boolean = if (Build.VERSION.SDK_INT >= 26) ValueAnimator.areAnimatorsEnabled()
        else Settings.Global.getFloat(ctx.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) > 0f

    private fun startHeroAutoCycle() {
        heroAutoJob?.cancel()
        heroAutoJob = scope.launch {
            while (!destroyed && visible) {
                delay(7_500L)
                val holder = activeHeroHolder
                val heroItems = feed?.hero ?: emptyList()
                if (visible && holder != null && holder.itemView.isAttachedToWindow &&
                    holder.itemView.hasWindowFocus() && !holder.itemView.hasFocus() && homeList.scrollState == RecyclerView.SCROLL_STATE_IDLE &&
                    animationsEnabled() &&
                    heroItems.size > 1
                ) {
                    heroIndex = (heroIndex + 1) % heroItems.size
                    holder.renderCurrent(animate = true)
                }
            }
        }
    }

    private fun load() {
        loadJob?.cancel()
        showLoading()
        loadJob = scope.launch {
            try {
                val initial = nav.app.douban.home { updated ->
                    scope.launch {
                        if (!destroyed) {
                            feed = updated
                            showFeed()
                        }
                    }
                }
                if (destroyed) return@launch
                feed = initial
                refreshContinue()
                showFeed()
            } catch (t: Throwable) {
                if (!destroyed && feed == null) {
                    container.removeAllViews()
                    val errBox = Theme.emptyOrErrorBox(ctx, Copy.errorText(t), Copy.Action.RETRY, focusRetry = true) { load() }
                    container.addView(errBox)
                }
            }
        }
    }

    private fun enrichEpisodes(item: MediaItem): MediaItem {
        if (item.episodes != null) return item
        val known = nav.app.playback.knownEpisodes(item.id) ?: return item
        return item.copy(episodes = known)
    }

    private fun refreshContinue() {
        continueJob?.cancel()
        if (!visible) return
        val entries = Rules.continuing(nav.app.userStore.get().history).take(14)
        if (entries.isEmpty()) {
            if (continuePairs.isNotEmpty()) {
                continuePairs = emptyList()
                syncBlocks()
            }
            return
        }
        continueJob = scope.launch {
            val items = runCatching { nav.app.douban.byIds(entries.map { it.id }) }.getOrNull() ?: return@launch
            ensureActive()
            if (destroyed) return@launch
            val map = items.associateBy { it.id }
            continuePairs = entries.mapNotNull { h -> map[h.id]?.let { enrichEpisodes(it) to h } }
            syncBlocks()

            val unresolvedSeries = continuePairs
                .map { it.first }
                .filter { it.episodes == null && it.type != MediaType.MOVIE }
                .take(4)
            if (unresolvedSeries.isNotEmpty()) {
                var updatedAny = false
                for (series in unresolvedSeries) {
                    val avail = runCatching {
                        nav.app.playback.availability(series, nav.app.douban.workHints(series.id))
                    }.getOrNull()
                    ensureActive()
                    if (avail?.episodes != null) updatedAny = true
                }
                if (!destroyed && updatedAny) {
                    continuePairs = entries.mapNotNull { h -> map[h.id]?.let { enrichEpisodes(it) to h } }
                    syncBlocks()
                }
            }
        }
    }

    private fun showLoading() {
        container.removeAllViews()
        container.addView(Theme.loadingBox(ctx))
    }

    private fun showFeed() {
        val firstMount = homeList.parent == null
        if (firstMount) {
            container.removeAllViews()
            container.addView(homeList, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            Theme.reveal(homeList)
        }
        syncBlocks()
        if (firstMount && savedInitialFocusAbsent() && container.findFocus() == null) {
            homeList.post {
                if (!container.isShown || !savedInitialFocusAbsent()) return@post
                homeList.selectedPosition = 0
                val target = activeHeroHolder?.primaryButton ?: homeList
                target.requestFocus()
            }
        }
    }

    private fun savedInitialFocusAbsent() = pendingFocus == null && restoreShelf == null && lastShelf == null

    private fun syncBlocks() {
        val current = feed ?: return
        val next = ArrayList<HomeBlock>()
        if (current.hero.isNotEmpty()) {
            next.add(HomeBlock.Hero(current.hero))
        }
        for (s in current.shelves) {
            when (s) {
                is Shelf.ContinueShelf -> if (continuePairs.isNotEmpty()) {
                    val sig = continuePairs.joinToString("|") {
                        "${it.first.id}:${it.first.episodes ?: 0}:${it.second.episode}:${it.second.position.toInt()}"
                    }
                    next.add(HomeBlock.Continue(continuePairs, sig))
                }
                is Shelf.RowShelf -> if (s.items.isNotEmpty()) {
                    next.add(HomeBlock.Row(s))
                }
                is Shelf.RankShelf -> if (s.boards.isNotEmpty()) {
                    next.add(HomeBlock.Rank(s.boards))
                }
            }
        }
        homeAdapter.submit(next)
        restoreShelf?.let { key ->
            val index = next.indexOfFirst { it.key == key }
            if (index >= 0) {
                lastShelf = key
                restoreShelf = null
                homeList.selectedPosition = index
            }
        }
    }

    private sealed interface HomeBlock {
        val key: String
        val viewType: Int
        fun sameContent(other: HomeBlock): Boolean

        data class Hero(val items: List<MediaItem>) : HomeBlock {
            override val key: String = "hero"
            override val viewType: Int = TYPE_HERO
            override fun sameContent(other: HomeBlock): Boolean = other is Hero && other.items == items
        }

        data class Continue(val pairs: List<Pair<MediaItem, HistoryEntry>>, val sig: String) : HomeBlock {
            override val key: String = "continue"
            override val viewType: Int = TYPE_SHELF_WIDE
            override fun sameContent(other: HomeBlock): Boolean = other is Continue && other.sig == sig
        }

        data class Row(val shelf: Shelf.RowShelf) : HomeBlock {
            override val key: String = shelf.shelfId
            override val viewType: Int = if (shelf.kind == "wide") TYPE_SHELF_WIDE else TYPE_SHELF_POSTER
            override fun sameContent(other: HomeBlock): Boolean = other is Row && other.shelf.items == shelf.items && other.shelf.title == shelf.title
        }

        data class Rank(val boards: List<RankBoard>) : HomeBlock {
            override val key: String = "rank"
            override val viewType: Int = TYPE_RANK
            override fun sameContent(other: HomeBlock): Boolean = other is Rank && other.boards == boards
        }
    }

    private inner class HomeAdapter : RecyclerView.Adapter<RecyclerView.ViewHolder>() {
        private var blocks: List<HomeBlock> = emptyList()

        init {
            setHasStableIds(true)
        }

        fun keyAt(index: Int) = blocks.getOrNull(index)?.key

        fun submit(next: List<HomeBlock>) {
            val previous = blocks
            val changes = DiffUtil.calculateDiff(object : DiffUtil.Callback() {
                override fun getOldListSize() = previous.size
                override fun getNewListSize() = next.size
                override fun areItemsTheSame(old: Int, new: Int) = previous[old].key == next[new].key
                override fun areContentsTheSame(old: Int, new: Int) = previous[old].sameContent(next[new])
                override fun getChangePayload(old: Int, new: Int): Any = PAYLOAD_UPDATE
            })
            blocks = next
            changes.dispatchUpdatesTo(this)
        }

        override fun getItemCount(): Int = blocks.size

        override fun getItemId(position: Int): Long = blocks[position].key.hashCode().toLong()

        override fun getItemViewType(position: Int): Int = blocks[position].viewType

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder {
            return when (viewType) {
                TYPE_HERO -> HeroViewHolder()
                TYPE_SHELF_WIDE -> ShelfViewHolder(wide = true)
                TYPE_SHELF_POSTER -> ShelfViewHolder(wide = false)
                else -> RankViewHolder()
            }
        }

        override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
            bindBlock(holder, blocks[position])
        }

        override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int, payloads: MutableList<Any>) {
            bindBlock(holder, blocks[position])
        }

        private fun bindBlock(holder: RecyclerView.ViewHolder, block: HomeBlock) {
            when {
                holder is HeroViewHolder && block is HomeBlock.Hero -> holder.bind(block.items)
                holder is ShelfViewHolder && block is HomeBlock.Continue -> holder.bindContinue(block.pairs)
                holder is ShelfViewHolder && block is HomeBlock.Row -> holder.bindShelf(block.shelf)
                holder is RankViewHolder && block is HomeBlock.Rank -> holder.bind(block.boards)
            }
        }

        override fun onViewAttachedToWindow(holder: RecyclerView.ViewHolder) {
            if (holder is HeroViewHolder) activeHeroHolder = holder
        }

        override fun onViewDetachedFromWindow(holder: RecyclerView.ViewHolder) {
            if (holder === activeHeroHolder) activeHeroHolder = null
        }
    }

    private inner class HeroViewHolder : RecyclerView.ViewHolder(buildHeroOuter()) {
        private val outer = itemView as HeroWrapperView
        private val card = FrameLayout(ctx)
        private val backdrop = FixedSizeImageView(ctx).apply { scaleType = ImageView.ScaleType.CENTER_CROP }
        private val titleTv = Theme.label(ctx, sp = 27f, color = Theme.PAPER_100, bold = true, maxLines = 1)
        private val scoreTv = Theme.label(ctx, sp = 13.5f, color = Theme.AMBER_400, bold = true)
        private val metaTv = Theme.label(ctx, sp = 13.5f, color = Theme.PAPER_70, maxLines = 1)
        private val synTv = Theme.label(ctx, sp = 13f, color = Theme.PAPER_70, maxLines = 2).apply {
            setLineSpacing(Theme.dp(ctx, 3).toFloat(), 1f)
        }
        val primaryButton = Theme.pillButton(ctx, Copy.Action.PLAY, primary = true, icon = TvIcon.PLAY, padH = 20, padV = 9, sp = 14f)
        private val detailBtn = Theme.pillButton(ctx, Copy.Action.DETAIL, padH = 18, padV = 9, sp = 14f)
        private val prevBtn = Theme.pillButton(ctx, "", icon = TvIcon.CHEVRON_LEFT, padH = 11, padV = 9).apply {
            contentDescription = ctx.getString(R.string.hero_previous)
        }
        private val nextBtn = Theme.pillButton(ctx, "", icon = TvIcon.CHEVRON_RIGHT, padH = 11, padV = 9).apply {
            contentDescription = ctx.getString(R.string.hero_next)
        }
        private val counterTv = Theme.label(ctx, sp = 12f, color = Theme.PAPER_70).apply {
            setPadding(Theme.dp(ctx, 10), Theme.dp(ctx, 4), Theme.dp(ctx, 10), Theme.dp(ctx, 4))
            background = Theme.box(0x990E0D0B.toInt(), Theme.LINE, radiusDp = 999, ctx = ctx)
        }
        private var currentItems: List<MediaItem> = emptyList()

        init {
            val h = (m.screenH * 0.45f).toInt().coerceIn(Theme.dp(ctx, 224), Theme.dp(ctx, 258))
            outer.primaryFocusTarget = primaryButton
            card.layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, h)
            card.background = Theme.box(Theme.INK_900, Theme.LINE, radiusDp = 20, ctx = ctx)
            card.clipToOutline = true
            card.addView(backdrop, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

            // Clean left-focused scrim so right 55% of hero artwork stays bright & luminous
            val sideScrim = View(ctx).apply {
                background = GradientDrawable(
                    GradientDrawable.Orientation.LEFT_RIGHT,
                    intArrayOf(0xEC0E0D0B.toInt(), 0x990E0D0B.toInt(), 0x0D0E0D0B),
                )
            }
            val bottomScrim = View(ctx).apply {
                background = GradientDrawable(
                    GradientDrawable.Orientation.BOTTOM_TOP,
                    intArrayOf(0xCC0E0D0B.toInt(), Color.TRANSPARENT),
                )
            }
            card.addView(sideScrim, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            card.addView(bottomScrim, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, (h * 0.48f).toInt(), Gravity.BOTTOM))

            val maxTextW = (m.innerW * 0.58f).toInt()
            val col = LinearLayout(ctx).apply {
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.BOTTOM
                clipChildren = false
                clipToPadding = false
                setPadding(Theme.dp(ctx, 28), Theme.dp(ctx, 16), Theme.dp(ctx, 28), Theme.dp(ctx, 20))
            }
            col.addView(titleTv, LinearLayout.LayoutParams(maxTextW, ViewGroup.LayoutParams.WRAP_CONTENT))

            val metaRow = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                layoutParams = LinearLayout.LayoutParams(maxTextW, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                    topMargin = Theme.dp(ctx, 7)
                }
            }
            scoreTv.apply {
                setPadding(Theme.dp(ctx, 7), Theme.dp(ctx, 2), Theme.dp(ctx, 7), Theme.dp(ctx, 2))
                background = Theme.box(0x33F4BD62, 0, radiusDp = 6, ctx = ctx)
                layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                    rightMargin = Theme.dp(ctx, 10)
                }
            }
            metaRow.addView(scoreTv)
            metaRow.addView(metaTv, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            col.addView(metaRow)

            synTv.layoutParams = LinearLayout.LayoutParams((m.innerW * 0.54f).toInt(), ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                topMargin = Theme.dp(ctx, 7)
                bottomMargin = Theme.dp(ctx, 14)
            }
            col.addView(synTv)

            val btnRow = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                clipChildren = false
                clipToPadding = false
                layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                    topMargin = Theme.dp(ctx, 2)
                }
            }
            primaryButton.layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                rightMargin = Theme.dp(ctx, 12)
            }
            detailBtn.layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                rightMargin = Theme.dp(ctx, 10)
            }
            prevBtn.layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                rightMargin = Theme.dp(ctx, 8)
            }
            nextBtn.layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                rightMargin = Theme.dp(ctx, 12)
            }

            val topEscape = View.OnKeyListener { _, keyCode, event ->
                if (event.action == KeyEvent.ACTION_DOWN && keyCode == KeyEvent.KEYCODE_DPAD_UP) {
                    if (homeList.selectedPosition != 0 || outer.top < -Theme.dp(ctx, 4)) {
                        homeList.setSelectedPositionSmooth(0)
                    } else {
                        nav.focusTopBar()
                    }
                    true
                } else false
            }
            primaryButton.setOnKeyListener(topEscape)
            detailBtn.setOnKeyListener(topEscape)
            prevBtn.setOnKeyListener(topEscape)
            nextBtn.setOnKeyListener(topEscape)

            btnRow.addView(primaryButton)
            btnRow.addView(detailBtn)
            btnRow.addView(prevBtn)
            btnRow.addView(nextBtn)
            btnRow.addView(counterTv)
            col.addView(btnRow)
            card.addView(col, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            outer.addView(card)

            prevBtn.setOnClickListener {
                if (currentItems.isEmpty()) return@setOnClickListener
                heroIndex = (heroIndex - 1 + currentItems.size) % currentItems.size
                renderCurrent(animate = true)
            }
            nextBtn.setOnClickListener {
                if (currentItems.isEmpty()) return@setOnClickListener
                heroIndex = (heroIndex + 1) % currentItems.size
                renderCurrent(animate = true)
            }
        }

        fun bind(items: List<MediaItem>) {
            val changed = items != currentItems
            currentItems = items
            if (items.isEmpty()) return
            heroIndex = if (heroId == null) heroIndex.coerceIn(items.indices)
                else items.indexOfFirst { it.id == heroId }.coerceAtLeast(0)
            val multiVis = if (items.size > 1) View.VISIBLE else View.GONE
            prevBtn.visibility = multiVis
            nextBtn.visibility = multiVis
            counterTv.visibility = multiVis
            if (changed || titleTv.text.isEmpty()) {
                renderCurrent(animate = false)
            }
        }

        fun renderCurrent(animate: Boolean) {
            if (currentItems.isEmpty()) return
            val item = currentItems[heroIndex.coerceIn(0, currentItems.lastIndex)]
            heroId = item.id
            nav.app.images.load(backdrop, Rules.wideImage(item), 1280, 720)
            titleTv.text = item.title
            val s = Rules.scoreText(item)
            scoreTv.visibility = if (s != null) View.VISIBLE else View.GONE
            scoreTv.text = s ?: ""
            metaTv.text = Rules.metaParts(item).joinToString(" · ")
            val hasSyn = !item.synopsis.isNullOrEmpty()
            synTv.visibility = if (hasSyn) View.VISIBLE else View.GONE
            synTv.text = item.synopsis ?: ""
            counterTv.text = "${heroIndex + 1} / ${currentItems.size}"
            primaryButton.setOnClickListener {
                val h = nav.app.userStore.get().history.firstOrNull { it.id == item.id }
                nav.openPlayer(item.id, h?.episode ?: 1)
            }
            detailBtn.setOnClickListener { nav.openDetail(item.id) }
            if (animate) {
                titleTv.animate().cancel()
                titleTv.alpha = 0.35f
                titleTv.animate().alpha(1f).setDuration(140L).setInterpolator(Theme.decelerate).start()
            }
        }
    }

    private fun buildHeroOuter(): HeroWrapperView {
        return HeroWrapperView(ctx).apply {
            clipChildren = false
            clipToPadding = false
            setPadding(m.pageH, Theme.dp(ctx, 8), m.pageH, 0)
            layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        }
    }

    private class HeroWrapperView(context: Context) : FrameLayout(context) {
        var primaryFocusTarget: View? = null

        override fun onRequestFocusInDescendants(direction: Int, previouslyFocusedRect: Rect?): Boolean {
            val target = primaryFocusTarget
            if (target != null && target.visibility == View.VISIBLE && target.isFocusable) {
                if (target.requestFocus(direction, previouslyFocusedRect)) return true
            }
            return super.onRequestFocusInDescendants(direction, previouslyFocusedRect)
        }
    }

    private inner class ShelfViewHolder(private val wide: Boolean) : RecyclerView.ViewHolder(
        LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            clipChildren = true
            clipToPadding = false
            layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        }
    ) {
        private val root = itemView as LinearLayout
        private val moreBtn = Theme.pillButton(ctx, Copy.Action.MORE, padH = 13, padV = 5, sp = 12f)
        private val head = Theme.sectionHeader(ctx, "", m.pageH, Theme.dp(ctx, 6), moreBtn)
        private val titleTv = head.getChildAt(1) as TextView
        private val rowGrid = Theme.horizontalGrid(ctx, root).apply {
            setItemSpacing(if (wide) m.wideGapH else m.gridGapH)
            setRecycledViewPool(if (wide) widePool else posterPool)
        }
        private val rowFrame = Theme.framedHorizontalRow(
            ctx,
            rowGrid,
            rowHeightPx = if (wide) m.wideRowH else m.posterRowH,
            padTopPx = m.rowPadV,
            padBottomPx = m.rowPadV,
        )
        private val cardsAdapter = CardRowAdapter(wide)

        init {
            root.addView(head)
            rowGrid.adapter = cardsAdapter
            root.addView(rowFrame)
        }

        fun bindShelf(shelf: Shelf.RowShelf) {
            if (titleTv.text.toString() != shelf.title) titleTv.text = shelf.title
            if (moreBtn.visibility != View.VISIBLE) moreBtn.visibility = View.VISIBLE
            moreBtn.setOnClickListener { nav.openChannel(shelf.moreType) }
            cardsAdapter.setItems(shelf.items, emptyMap())
            val index = shelf.items.indexOfFirst { it.id == pendingFocus }
            if (index >= 0) rowGrid.selectedPosition = index
        }

        fun bindContinue(pairs: List<Pair<MediaItem, HistoryEntry>>) {
            if (titleTv.text.toString() != Copy.Home.CONTINUE) titleTv.text = Copy.Home.CONTINUE
            if (moreBtn.visibility != View.GONE) moreBtn.visibility = View.GONE
            val historyMap = pairs.associate { (it, h) -> it.id to h }
            cardsAdapter.setItems(pairs.map { it.first }, history = historyMap)
        }
    }

    private inner class CardRowAdapter(private val wide: Boolean) : RecyclerView.Adapter<CardRowAdapter.VH>() {
        private var items: List<MediaItem> = emptyList()
        private var history: Map<String, HistoryEntry> = emptyMap()

        init {
            setHasStableIds(true)
        }

        fun setItems(newItems: List<MediaItem>, history: Map<String, HistoryEntry>) {
            if (items == newItems && this.history == history) return
            items = newItems
            this.history = history
            notifyDataSetChanged()
        }

        override fun getItemId(position: Int): Long = items[position].id.hashCode().toLong()

        override fun getItemViewType(position: Int): Int = if (wide) 1 else 0

        override fun getItemCount(): Int = items.size

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH =
            VH(MediaCardView(ctx, viewType == 1))

        override fun onBindViewHolder(holder: VH, position: Int) {
            val item = items[position]
            val h = history[item.id]
            val sub = if (h != null) Rules.progressText(item, h) else null
            val pct = h?.let { Rules.progressPercent(it) }
            holder.card.bind(nav.app, item, sub, pct)
            holder.card.setOnClickListener {
                if (h != null) nav.openPlayer(item.id, h.episode) else nav.openDetail(item.id)
            }
        }

        inner class VH(val card: MediaCardView) : RecyclerView.ViewHolder(card)
    }

    private inner class RankViewHolder : RecyclerView.ViewHolder(
        LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            clipChildren = false
            clipToPadding = false
            val hm = Theme.metrics(ctx).pageH
            setPadding(hm, 0, hm, 0)
            layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        }
    ) {
        private val root = itemView as LinearLayout
        private var lastBoards: List<RankBoard> = emptyList()

        fun bind(boards: List<RankBoard>) {
            if (boards == lastBoards) return
            lastBoards = boards
            root.removeAllViews()
            for (i in boards.indices) {
                val b = boards[i]
                val card = LinearLayout(ctx).apply {
                    orientation = LinearLayout.VERTICAL
                    clipChildren = false
                    clipToPadding = false
                    setPadding(Theme.dp(ctx, 16), Theme.dp(ctx, 16), Theme.dp(ctx, 16), Theme.dp(ctx, 14))
                    background = Theme.box(Theme.INK_900, Theme.LINE, radiusDp = 16, ctx = ctx)
                    layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                        if (i < boards.lastIndex) rightMargin = Theme.dp(ctx, 16)
                    }
                }
                val head = LinearLayout(ctx).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    clipChildren = false
                    layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                        bottomMargin = Theme.dp(ctx, 12)
                    }
                }
                head.addView(Theme.label(ctx, b.title, sp = 16.5f, color = Theme.PAPER_100, bold = true), LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
                head.addView(Theme.pillButton(ctx, Copy.Action.MORE, padH = 11, padV = 4, sp = 11.5f).apply {
                    setOnClickListener { nav.openChannel(b.moreType) }
                })
                card.addView(head)

                val thumbW = Theme.dp(ctx, 32)
                val thumbH = Theme.dp(ctx, 44)
                b.items.forEachIndexed { rankIdx, item ->
                    val entry = LinearLayout(ctx).apply {
                        orientation = LinearLayout.HORIZONTAL
                        gravity = Gravity.CENTER_VERTICAL
                        isFocusable = true
                        isFocusableInTouchMode = true
                        isClickable = true
                        setPadding(Theme.dp(ctx, 12), Theme.dp(ctx, 8), Theme.dp(ctx, 12), Theme.dp(ctx, 8))
                        background = Theme.focusBox(ctx, Color.TRANSPARENT, Theme.INK_850, normalStroke = 0, radiusDp = 10)
                        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                            if (rankIdx < b.items.lastIndex) bottomMargin = Theme.dp(ctx, 4)
                        }
                        setOnClickListener { nav.openDetail(item.id) }
                    }
                    Theme.focusScale(entry, 1.02f)

                    val numColor = if (rankIdx < 3) Theme.AMBER_400 else Theme.PAPER_52
                    entry.addView(Theme.label(ctx, "${rankIdx + 1}", sp = 14.5f, color = numColor, bold = true).apply {
                        layoutParams = LinearLayout.LayoutParams(Theme.dp(ctx, 22), ViewGroup.LayoutParams.WRAP_CONTENT)
                    })

                    val thumbBox = FrameLayout(ctx).apply {
                        layoutParams = LinearLayout.LayoutParams(thumbW, thumbH).apply {
                            rightMargin = Theme.dp(ctx, 10)
                        }
                        background = Theme.box(Theme.INK_850, Theme.LINE, radiusDp = 5, ctx = ctx)
                        clipToOutline = true
                    }
                    val thumbIv = FixedSizeImageView(ctx).apply { scaleType = ImageView.ScaleType.CENTER_CROP }
                    nav.app.images.load(thumbIv, item.poster, thumbW * 2, thumbH * 2)
                    thumbBox.addView(thumbIv, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
                    entry.addView(thumbBox)

                    val textCol = LinearLayout(ctx).apply {
                        orientation = LinearLayout.VERTICAL
                        layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                            rightMargin = Theme.dp(ctx, 8)
                        }
                    }
                    textCol.addView(Theme.label(ctx, item.title, sp = 13.5f, color = Theme.PAPER_100, bold = true, maxLines = 1))
                    Rules.rankSub(item)?.let { rSub ->
                        textCol.addView(Theme.label(ctx, rSub, sp = 11f, color = Theme.PAPER_52, maxLines = 1).apply {
                            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                                topMargin = Theme.dp(ctx, 2)
                            }
                        })
                    }
                    entry.addView(textCol)

                    Rules.scoreText(item)?.let { sc ->
                        entry.addView(Theme.label(ctx, sc, sp = 12.5f, color = Theme.AMBER_400, bold = true))
                    }
                    card.addView(entry)
                }
                root.addView(card)
            }
        }
    }

    companion object {
        private const val TYPE_HERO = 0
        private const val TYPE_SHELF_WIDE = 1
        private const val TYPE_SHELF_POSTER = 2
        private const val TYPE_RANK = 3
        private val PAYLOAD_UPDATE = Any()
    }
}
