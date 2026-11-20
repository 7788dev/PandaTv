package app.panda.tv.ui

import android.content.Context
import android.content.res.ColorStateList
import android.text.Editable
import android.text.TextUtils
import android.text.TextWatcher
import android.util.TypedValue
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import app.panda.tv.model.Copy
import app.panda.tv.model.MediaItem
import app.panda.tv.model.MediaType
import app.panda.tv.model.StateAction
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

class SearchScreen(ctx: Context, nav: Navigator) : Screen(ctx, nav) {
    override val activeTab: String? = null

    private val m = Theme.metrics(ctx)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
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
    private val input = EditText(ctx).apply {
        id = View.generateViewId()
        hint = Copy.Extra.SEARCH_INITIALS_PLACEHOLDER
        setHintTextColor(Theme.PAPER_52)
        setTextColor(Theme.PAPER_100)
        setTextSize(TypedValue.COMPLEX_UNIT_PX, 15f * Theme.unit(ctx))
        isSingleLine = true
        // Search uses the in-app D-pad keyboard below the field. Do not let a TV ROM
        // replace it with its vendor/system IME when the field receives focus.
        showSoftInputOnFocus = false
        imeOptions = EditorInfo.IME_ACTION_SEARCH
        isFocusable = true
        isFocusableInTouchMode = true
        setPadding(Theme.dp(ctx, 18), Theme.dp(ctx, 10), Theme.dp(ctx, 18), Theme.dp(ctx, 10))
        background = Theme.focusBox(ctx, Theme.INK_900, Theme.INK_850, Theme.LINE_2, Theme.BAMBOO_400, radiusDp = 12)
    }
    private val suggestStrip = Theme.horizontalGrid(ctx).apply {
        setItemSpacing(Theme.dp(ctx, 10))
    }
    private val suggestFrame = Theme.framedHorizontalRow(
        ctx,
        suggestStrip,
        rowHeightPx = Theme.dp(ctx, 46),
        padTopPx = Theme.dp(ctx, 2),
        padBottomPx = Theme.dp(ctx, 8),
    ).apply { visibility = View.GONE }

    private val typeFilterRow = Theme.horizontalGrid(ctx).apply {
        setItemSpacing(Theme.dp(ctx, 10))
    }
    private val typeFilterFrame = Theme.framedHorizontalRow(
        ctx,
        typeFilterRow,
        rowHeightPx = Theme.dp(ctx, 46),
        padTopPx = Theme.dp(ctx, 2),
        padBottomPx = Theme.dp(ctx, 8),
    ).apply { visibility = View.GONE }

    private val bodyBox = FrameLayout(ctx).apply {
        clipChildren = true
        clipToPadding = true
    }
    private val resultsGrid = Theme.verticalGrid(ctx, bodyBox).apply {
        setHorizontalSpacing(m.gridGapH)
        setVerticalSpacing(m.gridGapV)
        setPadding(m.pageH, Theme.dp(ctx, 12), m.pageH, Theme.dp(ctx, 40))
        Theme.bindGridHeaderNavigation(this, columns = 6) {
            if (typeFilterFrame.visibility == View.VISIBLE) typeFilterRow else input
        }
    }

    private var hotTerms: List<String> = emptyList()
    private var allResults: List<MediaItem> = emptyList()
    private var filteredResults: List<MediaItem> = emptyList()
    private var activeTypeFilter: MediaType? = null
    private var suggestJob: Job? = null
    private var searchJob: Job? = null
    private var searchGeneration = 0
    private var destroyed = false
    private var keyboardShown = false
    private var keypad: ViewGroup? = null
    private var completedQuery: String? = null
    private var editingSavedQuery: String? = null
    private var searchError: Throwable? = null
    private var restoringQuery = false
    private val suggestAdapter = ChipRowAdapter()
    private val typeFilterAdapter = TypeFilterAdapter()
    private val resultAdapter = ResultAdapter()

    override val view: View get() = root

    init {
        buildHeader()
        suggestStrip.adapter = suggestAdapter
        typeFilterRow.adapter = typeFilterAdapter
        resultsGrid.adapter = resultAdapter
        headerWrap.addView(suggestFrame)
        headerWrap.addView(typeFilterFrame)
        root.addView(headerWrap)
        root.addView(bodyBox, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        showDiscovery()
        loadHot()
        input.post {
            input.requestFocus()
            hideIme()
        }
    }

    override fun onDestroy() {
        destroyed = true
        suggestJob?.cancel()
        searchJob?.cancel()
        scope.cancel()
    }

    override fun onBackPressed(): Boolean {
        val saved = editingSavedQuery ?: return false
        if (!keyboardShown) return false
        searchGeneration++
        searchJob?.cancel()
        suggestJob?.cancel()
        editingSavedQuery = null
        restoringQuery = true
        input.setText(saved)
        input.setSelection(saved.length)
        restoringQuery = false
        suggestFrame.visibility = View.GONE
        val failure = searchError
        if (failure == null) applyTypeFilter(focusGrid = false) else showSearchError(saved, failure)
        input.requestFocus()
        hideIme()
        return true
    }

    private fun buildHeader() {
        val bar = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            clipChildren = false
            clipToPadding = false
            setPadding(m.pageH, Theme.dp(ctx, 12), m.pageH, Theme.dp(ctx, 10))
        }
        input.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_SEARCH || actionId == EditorInfo.IME_ACTION_DONE) {
                val q = input.text.toString().trim()
                if (q.isNotEmpty()) {
                    submit(q)
                    true
                } else false
            } else false
        }
        input.setOnKeyListener { _, keyCode, event ->
            if (keyCode == KeyEvent.KEYCODE_ENTER || keyCode == KeyEvent.KEYCODE_DPAD_CENTER) {
                if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) openKeyboard()
                true
            } else false
        }
        input.setOnClickListener { openKeyboard() }
        input.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(s: Editable?) {
                if (restoringQuery) return
                val q = s?.toString()?.trim().orEmpty()
                suggestJob?.cancel()
                suggestFrame.visibility = View.GONE
                if (q.isEmpty()) {
                    resetSearch()
                    return
                }
                if (!keyboardShown) openKeyboard(focusPad = false)
                suggestJob = scope.launch {
                    delay(260L)
                    val titles = runCatching {
                        if (q.matches(Regex("[a-zA-Z0-9\\s]+"))) nav.app.douban.titleHints(q)
                        else nav.app.douban.suggest(q).map { it.title }
                    }.getOrNull() ?: return@launch
                    if (destroyed || !keyboardShown || input.text.toString().trim() != q) return@launch
                    if (titles.isEmpty()) {
                        suggestFrame.visibility = View.GONE
                    } else {
                        suggestAdapter.setItems(titles) { picked ->
                            input.setText(picked)
                            input.setSelection(picked.length)
                            submit(picked)
                        }
                        suggestFrame.visibility = View.VISIBLE
                    }
                }
            }
        })
        bar.addView(input, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
            rightMargin = Theme.dp(ctx, 12)
        })
        bar.addView(Theme.pillButton(ctx, Copy.Search.LABEL, primary = true, icon = TvIcon.SEARCH, padH = 18, padV = 10, sp = 14f).apply {
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                rightMargin = Theme.dp(ctx, 10)
            }
            setOnClickListener { submit(input.text.toString()) }
        })
        bar.addView(Theme.pillButton(ctx, Copy.Action.CLEAR_INPUT, padH = 16, padV = 10, sp = 14f).apply {
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                rightMargin = Theme.dp(ctx, 10)
            }
            setOnClickListener {
                input.setText("")
                input.requestFocus()
            }
        })
        bar.addView(Theme.pillButton(ctx, Copy.Action.BACK, icon = TvIcon.BACK, padH = 16, padV = 10, sp = 14f).apply {
            setOnClickListener { if (!onBackPressed()) nav.back() }
        })
        headerWrap.addView(bar)
    }

    private fun hideIme() {
        val imm = ctx.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
        imm?.hideSoftInputFromWindow(input.windowToken, 0)
    }

    private fun openKeyboard(focusPad: Boolean = true) {
        hideIme()
        if (!keyboardShown) {
            searchGeneration++
            searchJob?.cancel()
            editingSavedQuery = completedQuery
            suggestFrame.visibility = View.GONE
        }
        showDiscovery(focusPad)
    }

    private fun resetSearch() {
        searchGeneration++
        searchJob?.cancel()
        suggestJob?.cancel()
        allResults = emptyList()
        filteredResults = emptyList()
        activeTypeFilter = null
        completedQuery = null
        editingSavedQuery = null
        searchError = null
        suggestFrame.visibility = View.GONE
        typeFilterFrame.visibility = View.GONE
        showDiscovery()
    }

    fun submit(raw: String) {
        val q = raw.trim()
        if (q.isEmpty()) {
            resetSearch()
            return
        }
        hideIme()
        keyboardShown = false
        keypad = null
        editingSavedQuery = null
        completedQuery = null
        searchError = null
        suggestJob?.cancel()
        suggestFrame.visibility = View.GONE
        nav.app.userStore.dispatch(StateAction.AddSearch(q))
        searchJob?.cancel()
        val generation = ++searchGeneration
        activeTypeFilter = null
        typeFilterFrame.visibility = View.GONE
        bodyBox.removeAllViews()
        bodyBox.addView(Theme.loadingBox(ctx))
        searchJob = scope.launch {
            try {
                val found = nav.app.douban.search(q)
                if (destroyed || generation != searchGeneration || input.text.toString().trim() != q) return@launch
                allResults = found
                completedQuery = q
                applyTypeFilter(focusGrid = true)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (t: Throwable) {
                if (!destroyed && generation == searchGeneration && input.text.toString().trim() == q) {
                    completedQuery = q
                    allResults = emptyList()
                    searchError = t
                    showSearchError(q, t)
                }
            }
        }
    }

    private fun applyTypeFilter(focusGrid: Boolean) {
        keyboardShown = false
        keypad = null
        val presentTypes = MediaType.entries.filter { tp -> allResults.any { it.type == tp } }
        if (presentTypes.size > 1) {
            val choices: List<MediaType?> = listOf(null) + presentTypes
            typeFilterAdapter.setChoices(choices, activeTypeFilter) { picked ->
                activeTypeFilter = picked
                applyTypeFilter(focusGrid = false)
            }
            typeFilterFrame.visibility = View.VISIBLE
        } else {
            typeFilterFrame.visibility = View.GONE
        }

        filteredResults = if (activeTypeFilter == null) allResults else allResults.filter { it.type == activeTypeFilter }
        if (filteredResults.isEmpty()) {
            bodyBox.removeAllViews()
            bodyBox.addView(Theme.emptyOrErrorBox(ctx, Copy.Search.EMPTY))
        } else {
            resultsGrid.stopScroll()
            resultsGrid.scrollToPosition(0)
            resultAdapter.notifyDataSetChanged()
            if (resultsGrid.parent != bodyBox) {
                bodyBox.removeAllViews()
                bodyBox.addView(resultsGrid, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
                Theme.reveal(resultsGrid)
            }
            if (focusGrid) resultsGrid.post { resultsGrid.requestFocus() }
        }
    }

    private fun showSearchError(query: String, error: Throwable) {
        keyboardShown = false
        keypad = null
        bodyBox.removeAllViews()
        bodyBox.addView(Theme.emptyOrErrorBox(ctx, Copy.errorText(error), Copy.Action.RETRY) { submit(query) })
    }

    private fun loadHot() {
        scope.launch {
            val loaded = runCatching { nav.app.douban.hotSearches() }.getOrNull() ?: return@launch
            if (!destroyed) {
                hotTerms = loaded
                if (input.text.toString().trim().isEmpty() && allResults.isEmpty()) showDiscovery()
            }
        }
    }

    private fun showDiscovery(focusPad: Boolean = false) {
        val focusedKey = keypad?.findFocus()?.tag as? String
        keyboardShown = true
        typeFilterFrame.visibility = View.GONE
        bodyBox.removeAllViews()
        val scroll = ScrollView(ctx).apply {
            isFocusable = false
            isVerticalScrollBarEnabled = false
            clipChildren = true
            clipToPadding = false
            descendantFocusability = ViewGroup.FOCUS_AFTER_DESCENDANTS
        }
        Theme.configureScrollView(ctx, scroll)
        val col = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            clipChildren = true
            clipToPadding = false
            setPadding(0, Theme.dp(ctx, 10), 0, Theme.dp(ctx, 36))
        }
        val recent = nav.app.userStore.get().searches
        if (recent.isNotEmpty()) {
            val clearBtn = Theme.pillButton(ctx, Copy.Action.CLEAR, padH = 12, padV = 5, sp = 12f).apply {
                setOnClickListener {
                    nav.app.userStore.dispatch(StateAction.ClearSearches)
                    showDiscovery()
                }
            }
            col.addView(Theme.sectionHeader(ctx, Copy.Search.RECENT, m.pageH, Theme.dp(ctx, 8), clearBtn))
            col.addView(chipGridRow(recent))
        }

        if (hotTerms.isNotEmpty()) {
            val sourceTag = Theme.label(ctx, Copy.Extra.HOT_SEARCH_SOURCE, sp = 12f, color = Theme.PAPER_52)
            val hotHeader = Theme.sectionHeader(ctx, Copy.Search.HOT, m.pageH, Theme.dp(ctx, 8), sourceTag).apply {
                if (recent.isNotEmpty()) {
                    layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                        topMargin = Theme.dp(ctx, 18)
                    }
                }
            }
            col.addView(hotHeader)
            col.addView(chipGridRow(hotTerms))
        }

        // 3-row x 13-column remote keypad so any key or Backspace is <= 2 Down + 6 Right moves away
        val keyRows = listOf(
            "ABCDEFGHIJKLM".map { it.toString() },
            "NOPQRSTUVWXYZ".map { it.toString() },
            "0123456789".map { it.toString() } + listOf("␣", "⌫", Copy.Search.LABEL),
        )
        val padBox = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            clipChildren = false
            clipToPadding = false
            setPadding(m.pageH, Theme.dp(ctx, 14), m.pageH, 0)
        }
        for (rIdx in keyRows.indices) {
            val rowKeys = keyRows[rIdx]
            val line = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                clipChildren = false
                clipToPadding = false
                layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                    if (rIdx < keyRows.lastIndex) bottomMargin = Theme.dp(ctx, 8)
                }
            }
            for (kIdx in rowKeys.indices) {
                val keyText = rowKeys[kIdx]
                val isGo = keyText == Copy.Search.LABEL
                val cell = TextView(ctx).apply {
                    id = View.generateViewId()
                    if (rIdx == 0) nextFocusUpId = input.id
                    if (rIdx == 0) setOnKeyListener { _, code, event ->
                        if (code == KeyEvent.KEYCODE_DPAD_UP) {
                            // ScrollView's arrow navigation searches only inside its
                            // descendants; an external nextFocusUpId is insufficient.
                            if (event.action == KeyEvent.ACTION_DOWN) input.requestFocus()
                            true
                        } else false
                    }
                    tag = "pad:$keyText"
                    text = keyText
                    setTextSize(TypedValue.COMPLEX_UNIT_PX, 13.5f * Theme.unit(ctx))
                    typeface = android.graphics.Typeface.DEFAULT_BOLD
                    maxLines = 1
                    gravity = Gravity.CENTER
                    isFocusable = true
                    isFocusableInTouchMode = true
                    isClickable = true
                    setPadding(0, Theme.dp(ctx, 9), 0, Theme.dp(ctx, 9))
                    background = Theme.focusBox(
                        ctx,
                        normalBg = if (isGo) Theme.BAMBOO_SOFT else Theme.INK_900,
                        focusedBg = if (isGo) Theme.BAMBOO_400 else Theme.FILL_2,
                        normalStroke = if (isGo) Theme.BAMBOO_LINE else Theme.LINE,
                        radiusDp = 10,
                    )
                    setTextColor(
                        ColorStateList(
                            arrayOf(intArrayOf(android.R.attr.state_focused), intArrayOf()),
                            intArrayOf(if (isGo) Theme.INK_950 else Theme.PAPER_50, if (isGo) Theme.BAMBOO_400 else Theme.PAPER_100),
                        )
                    )
                    Theme.focusScale(this, 1.04f)
                    setOnClickListener {
                        val cur = input.text.toString()
                        when (keyText) {
                            "⌫" -> if (cur.isNotEmpty()) input.setText(cur.substring(0, cur.length - 1))
                            "␣" -> input.setText("$cur ")
                            Copy.Search.LABEL -> submit(cur)
                            else -> input.setText(cur + keyText)
                        }
                        input.setSelection(input.text.length)
                    }
                }
                line.addView(cell, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                    if (kIdx < rowKeys.lastIndex) rightMargin = Theme.dp(ctx, 8)
                })
            }
            padBox.addView(line)
        }
        keypad = padBox
        col.addView(padBox)

        scroll.addView(col, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        bodyBox.addView(scroll, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        val focusTag = focusedKey ?: if (focusPad) "pad:A" else null
        if (focusTag != null) padBox.post {
            if (!destroyed && keyboardShown && keypad === padBox) padBox.findViewWithTag<View>(focusTag)?.requestFocus()
        }
    }

    private fun chipGridRow(terms: List<String>): FrameLayout {
        val grid = Theme.horizontalGrid(ctx).apply {
            setItemSpacing(Theme.dp(ctx, 10))
            adapter = ChipRowAdapter().apply {
                setItems(terms) { term ->
                    input.setText(term)
                    input.setSelection(term.length)
                    submit(term)
                }
            }
        }
        return Theme.framedHorizontalRow(
            ctx,
            grid,
            rowHeightPx = Theme.dp(ctx, 48),
            padTopPx = Theme.dp(ctx, 4),
            padBottomPx = Theme.dp(ctx, 4),
        )
    }

    private class ChipRowAdapter : RecyclerView.Adapter<ChipRowAdapter.VH>() {
        private var items: List<String> = emptyList()
        private var onClick: ((String) -> Unit)? = null

        fun setItems(list: List<String>, action: (String) -> Unit) {
            items = list
            onClick = action
            notifyDataSetChanged()
        }

        override fun getItemCount(): Int = items.size

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
            val c = parent.context
            val tv = TextView(c).apply {
                setTextSize(TypedValue.COMPLEX_UNIT_PX, 13f * Theme.unit(c))
                setTextColor(Theme.PAPER_100)
                maxLines = 1
                ellipsize = TextUtils.TruncateAt.END
                maxWidth = Theme.dp(c, 220)
                isFocusable = true
                isFocusableInTouchMode = true
                isClickable = true
                gravity = Gravity.CENTER
                setPadding(Theme.dp(c, 15), Theme.dp(c, 7), Theme.dp(c, 15), Theme.dp(c, 7))
                background = Theme.focusBox(c, Theme.INK_900, Theme.FILL_2, Theme.LINE, Theme.BAMBOO_400, radiusDp = 999)
                Theme.focusScale(this, 1.035f)
            }
            return VH(tv)
        }

        override fun onBindViewHolder(holder: VH, position: Int) {
            val label = items[position]
            holder.tv.text = label
            holder.tv.setOnClickListener { onClick?.invoke(label) }
        }

        class VH(val tv: TextView) : RecyclerView.ViewHolder(tv)
    }

    private class TypeFilterAdapter : RecyclerView.Adapter<TypeFilterAdapter.VH>() {
        private var choices: List<MediaType?> = emptyList()
        private var active: MediaType? = null
        private var onPick: ((MediaType?) -> Unit)? = null

        fun setChoices(list: List<MediaType?>, selected: MediaType?, pick: (MediaType?) -> Unit) {
            val changed = choices != list
            choices = list
            active = selected
            onPick = pick
            if (changed) notifyDataSetChanged() else notifyItemRangeChanged(0, choices.size)
        }

        override fun getItemCount(): Int = choices.size

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
            val c = parent.context
            val tv = TextView(c).apply {
                setTextSize(TypedValue.COMPLEX_UNIT_PX, 13f * Theme.unit(c))
                maxLines = 1
                isFocusable = true
                isFocusableInTouchMode = true
                isClickable = true
                gravity = Gravity.CENTER
                setPadding(Theme.dp(c, 15), Theme.dp(c, 6), Theme.dp(c, 15), Theme.dp(c, 6))
                background = Theme.focusBox(c, Theme.INK_900, Theme.FILL_2, Theme.LINE, Theme.BAMBOO_400, radiusDp = 999)
                Theme.focusScale(this, 1.035f)
            }
            return VH(tv)
        }

        override fun onBindViewHolder(holder: VH, position: Int) {
            val tp = choices[position]
            val sel = tp == active
            holder.tv.text = if (tp == null) Copy.Channel.ALL else Copy.Nav.of(tp)
            holder.tv.isSelected = sel
            holder.tv.setTextColor(
                ColorStateList(
                    arrayOf(intArrayOf(android.R.attr.state_focused), intArrayOf(android.R.attr.state_selected), intArrayOf()),
                    intArrayOf(Theme.PAPER_50, Theme.BAMBOO_400, Theme.PAPER_70),
                )
            )
            holder.tv.setOnClickListener { onPick?.invoke(tp) }
        }

        class VH(val tv: TextView) : RecyclerView.ViewHolder(tv)
    }

    private inner class ResultAdapter : RecyclerView.Adapter<ResultAdapter.VH>() {
        init {
            setHasStableIds(true)
        }

        override fun getItemId(position: Int): Long = filteredResults[position].id.hashCode().toLong()

        override fun getItemCount(): Int = filteredResults.size
        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH = VH(MediaCardView(ctx, wide = false))
        override fun onBindViewHolder(holder: VH, position: Int) {
            val item = filteredResults[position]
            holder.card.bind(nav.app, item)
            holder.card.setOnClickListener { nav.openDetail(item.id) }
        }
        inner class VH(val card: MediaCardView) : RecyclerView.ViewHolder(card)
    }
}
