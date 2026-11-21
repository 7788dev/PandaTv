package app.panda.tv.ui

import android.content.Context
import android.content.res.ColorStateList
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import app.panda.tv.model.ChannelFilters
import app.panda.tv.model.ChannelQuery
import app.panda.tv.model.Copy
import app.panda.tv.model.MediaItem
import app.panda.tv.model.MediaType
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

class ChannelScreen(ctx: Context, nav: Navigator, val type: MediaType, restoredPage: ChannelPageState? = null) : Screen(ctx, nav) {
    override val activeTab: String = type.wire

    private val m = Theme.metrics(ctx)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    // HeaderFirstLinearLayout draws contentBox first and headerWrap last on top, preventing any scroll overlap
    private val root = Theme.headerFirstColumn(ctx).apply {
        clipChildren = true
    }
    private val headerWrap = LinearLayout(ctx).apply {
        orientation = LinearLayout.VERTICAL
        setBackgroundColor(Theme.INK_950)
        clipChildren = false
        clipToPadding = false
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
    }
    private val barRow = LinearLayout(ctx).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        clipChildren = false
        clipToPadding = false
        setPadding(m.pageH, Theme.dp(ctx, 12), m.pageH, Theme.dp(ctx, 10))
    }
    private val chipRow = Theme.horizontalGrid(ctx).apply {
        setItemSpacing(Theme.dp(ctx, 10))
        setOnUnhandledKeyListener { event ->
            if (event.action == KeyEvent.ACTION_DOWN && event.keyCode == KeyEvent.KEYCODE_DPAD_UP) {
                anchorFor(openDimension)?.requestFocus()
                true
            } else false
        }
    }
    private val chipDrawer = LinearLayout(ctx).apply {
        orientation = LinearLayout.VERTICAL
        visibility = View.GONE
        setBackgroundColor(Theme.INK_950)
        addView(
            Theme.framedHorizontalRow(
                ctx,
                chipRow,
                rowHeightPx = Theme.dp(ctx, 48),
                padTopPx = Theme.dp(ctx, 4),
                padBottomPx = Theme.dp(ctx, 8),
            )
        )
        addView(Theme.hairline(ctx))
    }
    private val contentBox = FrameLayout(ctx).apply {
        clipChildren = true
        clipToPadding = true
    }
    private val grid = Theme.verticalGrid(ctx, contentBox).apply {
        setHorizontalSpacing(m.gridGapH)
        setVerticalSpacing(m.gridGapV)
        setPadding(m.pageH, Theme.dp(ctx, 12), m.pageH, Theme.dp(ctx, 10))
        Theme.bindGridHeaderNavigation(this, columns = 6, onReachEnd = ::onGridEnd) {
            if (chipDrawer.visibility == View.VISIBLE) chipRow else sortButtons[query.sort]
        }
    }
    private val pageFooter = PosterPageFooter(ctx, grid) { loadMore(retry = true) }

    private val filters: ChannelFilters = nav.app.douban.filters(type)
    private var query = restoredPage?.query ?: ChannelQuery(sort = "hot")
    private var openDimension: String? = null
    private val items = ArrayList<MediaItem>()
    private var nextCursor: String? = null
    private var loading = false
    private var initialLoaded = false
    private var destroyed = false
    private var loadJob: Job? = null

    private val sortButtons = LinkedHashMap<String, LinearLayout>()
    private lateinit var genreBtn: LinearLayout
    private lateinit var regionBtn: LinearLayout
    private lateinit var yearBtn: LinearLayout
    private lateinit var clearBtn: LinearLayout

    private val chipAdapter = ChipAdapter()
    private val gridAdapter = GridAdapter()

    override val view: View get() = root

    init {
        buildFilterBar()
        chipRow.adapter = chipAdapter
        grid.adapter = gridAdapter
        contentBox.addView(grid, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        headerWrap.addView(barRow)
        headerWrap.addView(chipDrawer, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        root.addView(headerWrap)
        root.addView(contentBox, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        root.addView(pageFooter)
        refreshLabels()
        if (restoredPage?.loaded == true) {
            items.addAll(restoredPage.items)
            nextCursor = restoredPage.nextCursor
            initialLoaded = true
            showItems()
            if (items.isNotEmpty()) {
                grid.selectedPosition = restoredPage.selectedPosition.coerceIn(items.indices)
                restoredPage.layoutState?.let { grid.layoutManager?.onRestoreInstanceState(it) }
                restoredPage.focusPosition?.let { rememberGridFocus(grid, it) }
            }
            if (restoredPage.pageFailed) pageFooter.show(Copy.Channel.LOAD_MORE_FAILED, retryable = true)
            restoredPage.controlFocus?.let { key -> controlForKey(key)?.let { rememberControlFocus(it) } }
            android.util.Log.i("PandaTV", "[navigation] restore type=${type.wire} selected=${restoredPage.selectedPosition} focus=${restoredPage.focusPosition} control=${restoredPage.controlFocus}")
        } else reload()
    }

    fun savePageState(): ChannelPageState {
        val saved = ChannelPageState(
            query = query,
            items = items.toList(),
            nextCursor = nextCursor,
            loaded = initialLoaded,
            layoutState = grid.layoutManager?.onSaveInstanceState(),
            selectedPosition = grid.selectedPosition,
            focusPosition = rememberedGridPosition(grid),
            controlFocus = rememberedControlKey(),
            pageFailed = pageFooter.failed,
        )
        android.util.Log.i("PandaTV", "[navigation] save type=${type.wire} selected=${saved.selectedPosition} focus=${saved.focusPosition} control=${saved.controlFocus}")
        return saved
    }

    private fun rememberedControlKey(): String? {
        val target = rememberedContentTarget() ?: return null
        sortButtons.entries.firstOrNull { it.value === target }?.let { return "sort:${it.key}" }
        return when (target) {
            genreBtn -> "genre"
            regionBtn -> "region"
            yearBtn -> "year"
            clearBtn -> "clear"
            pageFooter.retry -> "page-retry"
            else -> null
        }
    }

    private fun controlForKey(key: String): View? = if (key.startsWith("sort:")) sortButtons[key.removePrefix("sort:")] else when (key) {
        "genre" -> genreBtn
        "region" -> regionBtn
        "year" -> yearBtn
        "clear" -> clearBtn
        "page-retry" -> pageFooter.retry
        else -> null
    }

    override fun onBackPressed(): Boolean {
        val dim = openDimension ?: return false
        closeChipDrawer()
        val anchor = anchorFor(dim)
        anchor?.post { anchor.requestFocus() }
        return true
    }

    override fun onDestroy() {
        destroyed = true
        loadJob?.cancel()
        scope.cancel()
    }

    private fun anchorFor(dim: String?): LinearLayout? = when (dim) {
        "genre" -> genreBtn
        "region" -> regionBtn
        "year" -> yearBtn
        else -> null
    }

    private fun closeChipDrawer() {
        openDimension = null
        chipDrawer.animate().cancel()
        chipDrawer.visibility = View.GONE
        chipDrawer.alpha = 1f
        chipDrawer.translationY = 0f
    }

    private fun buildFilterBar() {
        val upToTopBar = View.OnKeyListener { _, keyCode, event ->
            if (event.action == KeyEvent.ACTION_DOWN && keyCode == KeyEvent.KEYCODE_DPAD_UP) {
                nav.focusTopBar()
                true
            } else false
        }

        barRow.addView(Theme.label(ctx, Copy.Nav.of(type), sp = 20f, color = Theme.PAPER_100, bold = true).apply {
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                rightMargin = Theme.dp(ctx, 16)
            }
        })
        for ((key, label) in listOf("hot" to Copy.Channel.SORT_HOT, "new" to Copy.Channel.SORT_NEW, "score" to Copy.Channel.SORT_SCORE)) {
            val btn = Theme.pillButton(ctx, label, padH = 14, padV = 6, sp = 13f).apply {
                layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                    rightMargin = Theme.dp(ctx, 7)
                }
                setOnKeyListener(upToTopBar)
                setOnClickListener {
                    if (query.sort != key) {
                        query = query.copy(sort = key)
                        refreshLabels()
                        reload()
                    }
                }
            }
            sortButtons[key] = btn
            barRow.addView(btn)
        }

        barRow.addView(View(ctx).apply {
            setBackgroundColor(Theme.LINE_2)
            layoutParams = LinearLayout.LayoutParams(1, Theme.dp(ctx, 18)).apply {
                leftMargin = Theme.dp(ctx, 8)
                rightMargin = Theme.dp(ctx, 14)
            }
        })

        genreBtn = Theme.pillButton(ctx, Copy.Channel.GENRE, padH = 13, padV = 6, sp = 13f, maxTextWidthDp = 128).apply {
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                rightMargin = Theme.dp(ctx, 8)
            }
            setOnKeyListener(upToTopBar)
            setOnClickListener { toggleDimension("genre") }
        }
        regionBtn = Theme.pillButton(ctx, Copy.Channel.REGION, padH = 13, padV = 6, sp = 13f, maxTextWidthDp = 128).apply {
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                rightMargin = Theme.dp(ctx, 8)
            }
            setOnKeyListener(upToTopBar)
            setOnClickListener { toggleDimension("region") }
        }
        yearBtn = Theme.pillButton(ctx, Copy.Channel.YEAR, padH = 13, padV = 6, sp = 13f, maxTextWidthDp = 120).apply {
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                rightMargin = Theme.dp(ctx, 10)
            }
            setOnKeyListener(upToTopBar)
            setOnClickListener { toggleDimension("year") }
        }
        clearBtn = Theme.pillButton(ctx, Copy.Action.CLEAR_FILTERS, padH = 13, padV = 6, sp = 13f).apply {
            setOnKeyListener(upToTopBar)
            setOnClickListener {
                query = query.copy(genre = null, region = null, year = null)
                closeChipDrawer()
                refreshLabels()
                genreBtn.post { genreBtn.requestFocus() }
                reload()
            }
        }
        barRow.addView(genreBtn)
        barRow.addView(regionBtn)
        barRow.addView(yearBtn)
        barRow.addView(clearBtn)
    }

    private fun toggleDimension(dim: String) {
        if (openDimension == dim) {
            closeChipDrawer()
            return
        }
        val wasOpen = chipDrawer.visibility == View.VISIBLE
        openDimension = dim
        val options = when (dim) {
            "genre" -> listOf(Copy.Channel.ALL) + filters.genres
            "region" -> listOf(Copy.Channel.ALL) + filters.regions
            else -> listOf(Copy.Channel.ALL) + filters.years
        }
        val active = when (dim) {
            "genre" -> query.genre
            "region" -> query.region
            else -> query.year
        }
        val activeIdx = options.indexOf(active ?: Copy.Channel.ALL).coerceAtLeast(0)
        chipAdapter.setOptions(options, active) { picked ->
            val clean = if (picked == Copy.Channel.ALL) null else picked
            query = when (dim) {
                "genre" -> query.copy(genre = clean)
                "region" -> query.copy(region = clean)
                else -> query.copy(year = clean)
            }
            closeChipDrawer()
            refreshLabels()
            val anchor = anchorFor(dim)
            anchor?.post { anchor.requestFocus() }
            reload()
        }
        chipDrawer.animate().cancel()
        chipDrawer.visibility = View.VISIBLE
        Theme.reveal(chipDrawer, if (wasOpen) 0 else -Theme.dp(ctx, 4))
        chipRow.post {
            chipRow.scrollToPosition(activeIdx)
            chipRow.requestFocus()
        }
    }

    private fun setBtnLabel(btn: LinearLayout, text: String, selected: Boolean) {
        val tv = (0 until btn.childCount).firstNotNullOfOrNull { btn.getChildAt(it) as? TextView } ?: return
        tv.text = text
        Theme.setPillSelected(btn, selected)
    }

    private fun refreshLabels() {
        for ((k, btn) in sortButtons) {
            val label = when (k) {
                "new" -> Copy.Channel.SORT_NEW
                "score" -> Copy.Channel.SORT_SCORE
                else -> Copy.Channel.SORT_HOT
            }
            setBtnLabel(btn, label, query.sort == k)
        }
        setBtnLabel(genreBtn, "${Copy.Channel.GENRE}: ${query.genre ?: Copy.Channel.ALL}", query.genre != null)
        setBtnLabel(regionBtn, "${Copy.Channel.REGION}: ${query.region ?: Copy.Channel.ALL}", query.region != null)
        setBtnLabel(yearBtn, "${Copy.Channel.YEAR}: ${query.year ?: Copy.Channel.ALL}", query.year != null)
        clearBtn.visibility = if (query.genre != null || query.region != null || query.year != null) View.VISIBLE else View.GONE
    }

    private fun reload() {
        loadJob?.cancel()
        loading = false
        initialLoaded = false
        pageFooter.show()
        items.clear()
        nextCursor = null
        gridAdapter.notifyDataSetChanged()
        contentBox.removeAllViews()
        contentBox.addView(posterPageLoading(ctx, grid))
        loadPage(initial = true)
    }

    private fun showItems() {
        contentBox.removeAllViews()
        if (items.isEmpty()) {
            contentBox.addView(Theme.emptyOrErrorBox(ctx, Copy.Channel.EMPTY))
        } else {
            grid.scrollToPosition(0)
            contentBox.addView(grid, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            gridAdapter.notifyDataSetChanged()
            Theme.reveal(grid)
        }
    }

    private fun onGridEnd(position: Int, isNewPress: Boolean) {
        if (nextCursor == null) pageFooter.show(Copy.Channel.END)
        else pageFooter.onGridEnd(position, isNewPress) { loadMore() }
    }

    private fun loadMore(retry: Boolean = false) {
        if (destroyed || !grid.isAttachedToWindow || loading || nextCursor == null || (pageFooter.failed && !retry)) return
        loadPage(initial = false)
    }

    private fun loadPage(initial: Boolean) {
        loading = true
        if (!initial) pageFooter.show(Copy.Channel.LOADING_MORE)
        loadJob = scope.launch {
            try {
                val data = nav.app.douban
                val mediaType = type
                val requestQuery = query
                val cursor = if (initial) null else nextCursor
                val page = awaitScreenRequest(scope) { data.channel(mediaType, requestQuery, cursor) }
                if (destroyed) return@launch
                val seen = items.map { it.id }.toHashSet()
                val added = page.items.filter { seen.add(it.id) }
                val startPos = items.size
                items.addAll(added)
                nextCursor = page.next
                loading = false
                if (initial) {
                    initialLoaded = true
                    showItems()
                } else {
                    pageFooter.show()
                    if (added.isNotEmpty()) gridAdapter.notifyItemRangeInserted(startPos, added.size)
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (t: Throwable) {
                android.util.Log.w("PandaTV", "[channel] initial=$initial count=${items.size}: ${t.message}")
                loading = false
                if (!destroyed) {
                    if (initial) {
                        contentBox.removeAllViews()
                        contentBox.addView(Theme.emptyOrErrorBox(ctx, Copy.errorText(t), Copy.Action.RETRY) { reload() })
                    } else {
                        pageFooter.show(Copy.Channel.LOAD_MORE_FAILED, retryable = true)
                    }
                }
            }
        }
    }

    private class ChipAdapter : RecyclerView.Adapter<ChipAdapter.VH>() {
        private var list: List<String> = emptyList()
        private var selected: String? = null
        private var onPick: ((String) -> Unit)? = null

        fun setOptions(options: List<String>, active: String?, pick: (String) -> Unit) {
            list = options
            selected = active ?: Copy.Channel.ALL
            onPick = pick
            notifyDataSetChanged()
        }

        override fun getItemCount(): Int = list.size

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
            val c = parent.context
            val tv = TextView(c).apply {
                setTextSize(TypedValue.COMPLEX_UNIT_PX, 13f * Theme.unit(c))
                maxLines = 1
                ellipsize = TextUtils.TruncateAt.END
                maxWidth = Theme.dp(c, 190)
                isFocusable = true
                isFocusableInTouchMode = true
                isClickable = true
                gravity = Gravity.CENTER
                setPadding(Theme.dp(c, 14), Theme.dp(c, 6), Theme.dp(c, 14), Theme.dp(c, 6))
                background = Theme.focusBox(c, Theme.INK_900, Theme.FILL_2, Theme.LINE, Theme.BAMBOO_400, radiusDp = 999)
                Theme.focusScale(this, 1.035f)
            }
            return VH(tv)
        }

        override fun onBindViewHolder(holder: VH, position: Int) {
            val text = list[position]
            val active = text == selected
            holder.tv.text = text
            holder.tv.isSelected = active
            holder.tv.setTextColor(
                ColorStateList(
                    arrayOf(intArrayOf(android.R.attr.state_focused), intArrayOf(android.R.attr.state_selected), intArrayOf()),
                    intArrayOf(Theme.PAPER_50, Theme.BAMBOO_400, Theme.PAPER_70),
                )
            )
            holder.tv.setOnClickListener { onPick?.invoke(text) }
        }

        class VH(val tv: TextView) : RecyclerView.ViewHolder(tv)
    }

    private inner class GridAdapter : RecyclerView.Adapter<GridAdapter.VH>() {
        init {
            setHasStableIds(true)
        }

        override fun getItemId(position: Int): Long = items[position].id.hashCode().toLong()

        override fun getItemCount(): Int = items.size

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH =
            VH(MediaCardView(ctx, wide = false))

        override fun onBindViewHolder(holder: VH, position: Int) {
            // A cached page may resume immediately on Main.immediate. Posting
            // keeps its adapter notification outside RecyclerView's bind/layout.
            if (position >= items.size - 12) grid.post {
                if (position >= items.size - 12) loadMore()
            }
            val item = items[position]
            holder.card.bind(nav.app, item)
            holder.card.setOnClickListener { nav.openDetail(item.id) }
        }

        inner class VH(val card: MediaCardView) : RecyclerView.ViewHolder(card)
    }
}
