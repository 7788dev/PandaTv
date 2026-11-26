package app.panda.tv.ui

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.StateListDrawable
import android.os.SystemClock
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.KeyEvent
import android.view.LayoutInflater
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.ViewTreeObserver
import android.view.animation.DecelerateInterpolator
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import androidx.leanback.widget.BaseGridView
import androidx.leanback.widget.HorizontalGridView
import androidx.leanback.widget.VerticalGridView
import androidx.recyclerview.widget.RecyclerView
import app.panda.tv.PandaTvApp
import app.panda.tv.R
import app.panda.tv.model.Copy
import app.panda.tv.model.MediaItem
import app.panda.tv.model.Rules
import kotlin.math.roundToInt

object Theme {
    const val INK_950 = 0xFF0E0D0B.toInt()
    const val INK_900 = 0xFF151412.toInt()
    const val INK_850 = 0xFF1D1C19.toInt()
    const val INK_800 = 0xFF262421.toInt()
    const val INK_700 = 0xFF35322F.toInt()

    const val PAPER_100 = 0xFFEFEAE2.toInt()
    const val PAPER_50 = 0xFFFCFAF6.toInt()
    const val PAPER_70 = 0xB3EFEAE2.toInt()
    const val PAPER_52 = 0x85EFEAE2.toInt()
    const val PAPER_32 = 0x52EFEAE2.toInt()

    const val LINE = 0x14EFEAE2
    const val LINE_2 = 0x29EFEAE2
    const val FILL = 0x12EFEAE2
    const val FILL_2 = 0x22EFEAE2

    const val BAMBOO_400 = 0xFF79D4A1.toInt()
    const val BAMBOO_300 = 0xFFA5E6BF.toInt()
    const val BAMBOO_SOFT = 0x2479D4A1
    const val BAMBOO_LINE = 0x5979D4A1
    const val AMBER_400 = 0xFFF4BD62.toInt()
    const val CINNABAR_400 = 0xFFF3705E.toInt()
    const val CINNABAR_SOFT = 0x24F3705E
    const val SCRIM = 0xA80E0D0B.toInt()
    const val GLASS_STRONG = 0xEB141311.toInt()

    val decelerate = DecelerateInterpolator(1.8f)
    private var lastFocusChangeMs = 0L

    /**
     * Canonical 960x540 TV viewport scale factor.
     * At 1920x1080 this equals 2.0 regardless of whether a domestic TV ROM reports 160, 240, 320, or 480 dpi
     * or an oversized system fontScale, guaranteeing zero DPI/fontScale overflow across all 720p/1080p/4K TVs.
     */
    fun unit(ctx: Context): Float {
        val dm = ctx.resources.displayMetrics
        val w = maxOf(dm.widthPixels, dm.heightPixels).coerceAtLeast(640)
        val h = minOf(dm.widthPixels, dm.heightPixels).coerceAtLeast(360)
        return minOf(w / 960f, h / 540f)
    }

    class Metrics(ctx: Context) {
        val dm = ctx.resources.displayMetrics
        val screenW: Int = maxOf(dm.widthPixels, dm.heightPixels)
        val screenH: Int = minOf(dm.widthPixels, dm.heightPixels)
        val safeV: Int = (screenH * 0.053f).roundToInt()


        val pageH: Int = (screenW * 0.053f).roundToInt().coerceAtLeast(dp(ctx, 32))
        val innerW: Int = (screenW - pageH * 2).coerceAtLeast(dp(ctx, 560))

        val gridGapH: Int = dp(ctx, 16)
        val gridGapV: Int = dp(ctx, 22)
        val wideGapH: Int = dp(ctx, 18)

        val cardPadH: Int = dp(ctx, 7)
        val cardPadTop: Int = dp(ctx, 7)
        val cardPadBottom: Int = dp(ctx, 10)

        /** Exact 6-column poster card outer width guaranteed to fit 100% inside innerW without overflow. */
        val posterCardW: Int = ((innerW - gridGapH * 5) / 6).coerceAtLeast(1)
        val posterImgW: Int = (posterCardW - cardPadH * 2).coerceAtLeast(1)
        val posterImgH: Int = posterImgW * 3 / 2

        /** Exact 4-column widescreen card outer width for Continue Watching, History, Variety & Documentary. */
        val wideCardW: Int = ((innerW - wideGapH * 3) / 4).coerceAtLeast(1)
        val wideImgW: Int = (wideCardW - cardPadH * 2).coerceAtLeast(1)
        val wideImgH: Int = wideImgW * 9 / 16

        val rowFocusInset: Int = dp(ctx, 8)
        val rowPadV: Int = dp(ctx, 8)
        private val textBlockPx: Int = sp(ctx, 21f) + sp(ctx, 18f) + dp(ctx, 16)
        private val focusAllowancePx: Int = dp(ctx, 10)

        val posterRowH: Int = rowPadV * 2 + cardPadTop + posterImgH + textBlockPx + cardPadBottom + focusAllowancePx
        val wideRowH: Int = rowPadV * 2 + cardPadTop + wideImgH + textBlockPx + cardPadBottom + focusAllowancePx
    }

    fun metrics(ctx: Context): Metrics = Metrics(ctx)

    fun dp(ctx: Context, value: Int): Int =
        (value * unit(ctx)).roundToInt()

    fun sp(ctx: Context, value: Float): Int =
        (value * unit(ctx)).roundToInt()

    fun box(bg: Int, stroke: Int = 0, radiusDp: Int = 8, strokeDp: Int = 1, ctx: Context? = null): GradientDrawable {
        val u = if (ctx != null) unit(ctx) else 2f
        return GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = radiusDp * u
            setColor(bg)
            if (stroke != 0) setStroke((strokeDp * u).roundToInt().coerceAtLeast(1), stroke)
        }
    }

    /**
     * Distinct visual states for TV remote navigation:
     * - focused: unmistakable 2dp bright BAMBOO_400 cursor ring (unique on screen)
     * - selected (unfocused): soft BAMBOO_SOFT surface + 1dp subtle border so active tabs never impersonate the cursor
     * - default: quiet ambient surface
     */
    fun focusBox(
        ctx: Context,
        normalBg: Int,
        focusedBg: Int = normalBg,
        normalStroke: Int = LINE,
        focusedStroke: Int = BAMBOO_400,
        selectedBg: Int = BAMBOO_SOFT,
        selectedStroke: Int = BAMBOO_LINE,
        radiusDp: Int = 10,
        normalStrokeDp: Int = 1,
        focusedStrokeDp: Int = 2,
    ): StateListDrawable {
        return StateListDrawable().apply {
            addState(intArrayOf(android.R.attr.state_focused), box(focusedBg, focusedStroke, radiusDp, focusedStrokeDp, ctx))
            addState(intArrayOf(android.R.attr.state_selected), box(selectedBg, selectedStroke, radiusDp, normalStrokeDp, ctx))
            addState(intArrayOf(), box(normalBg, normalStroke, radiusDp, normalStrokeDp, ctx))
        }
    }

    fun focusScale(view: View, scale: Float = 1.035f, onFocusChanged: ((Boolean) -> Unit)? = null) {
        // Disable dynamic outline shadow projection on Mali/Cortex-A53 while preserving RenderNode Z ordering
        view.outlineProvider = null
        view.setOnFocusChangeListener { v, hasFocus ->
            val now = SystemClock.uptimeMillis()
            val rapid = (now - lastFocusChangeMs) < 140L
            if (hasFocus) lastFocusChangeMs = now
            v.animate().cancel()
            val target = if (hasFocus) scale else 1f
            v.translationZ = if (hasFocus) 1f else 0f
            if (!hasFocus || rapid) {
                v.scaleX = target
                v.scaleY = target
            } else {
                v.scaleX = maxOf(v.scaleX, minOf(scale, 1.012f))
                v.scaleY = maxOf(v.scaleY, minOf(scale, 1.012f))
                v.animate()
                    .scaleX(target)
                    .scaleY(target)
                    .setDuration(95L)
                    .setInterpolator(decelerate)
                    .start()
            }
            onFocusChanged?.invoke(hasFocus)
        }
        view.addOnAttachStateChangeListener(object : View.OnAttachStateChangeListener {
            override fun onViewAttachedToWindow(v: View) = Unit
            override fun onViewDetachedFromWindow(v: View) {
                v.animate().cancel()
                v.scaleX = 1f
                v.scaleY = 1f
                v.translationZ = 0f
            }
        })
    }

    fun reveal(view: View, risePx: Int = 0) {
        view.animate().cancel()
        view.alpha = 0.8f
        view.translationY = risePx.toFloat()
        view.animate().alpha(1f).translationY(0f).setStartDelay(0L)
            .setDuration(120L).setInterpolator(decelerate).start()
    }

    fun label(
        ctx: Context,
        text: String = "",
        sp: Float = 14f,
        color: Int = PAPER_100,
        bold: Boolean = false,
        maxLines: Int = 1,
    ): TextView {
        return TextView(ctx).apply {
            this.text = text
            setTextSize(TypedValue.COMPLEX_UNIT_PX, sp * unit(ctx))
            setTextColor(color)
            if (bold) typeface = android.graphics.Typeface.DEFAULT_BOLD
            if (maxLines > 0) {
                this.maxLines = maxLines
                ellipsize = TextUtils.TruncateAt.END
            }
        }
    }

    fun pillButton(
        ctx: Context,
        text: String,
        primary: Boolean = false,
        danger: Boolean = false,
        icon: TvIcon? = null,
        padH: Int = 18,
        padV: Int = 9,
        sp: Float = 13.5f,
        maxTextWidthDp: Int = 0,
    ): LinearLayout {
        val normalBg = when {
            primary -> PAPER_100
            danger -> CINNABAR_SOFT
            else -> FILL
        }
        val focusBg = when {
            primary -> PAPER_50
            danger -> CINNABAR_400
            else -> FILL_2
        }
        val normalText = when {
            primary -> INK_950
            danger -> CINNABAR_400
            else -> PAPER_100
        }
        val focusText = when {
            primary || danger -> INK_950
            else -> PAPER_50
        }

        return LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            isFocusable = true
            isFocusableInTouchMode = true
            isClickable = true
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            setPadding(dp(ctx, padH), dp(ctx, padV), dp(ctx, padH), dp(ctx, padV))
            background = focusBox(
                ctx,
                normalBg = normalBg,
                focusedBg = focusBg,
                normalStroke = if (primary) 0 else LINE,
                focusedStroke = if (danger) CINNABAR_400 else BAMBOO_400,
                selectedBg = if (primary) PAPER_100 else BAMBOO_SOFT,
                selectedStroke = if (primary) 0 else BAMBOO_LINE,
                radiusDp = 999,
            )
            val iconView = icon?.let {
                TvIconView(ctx, it, normalText).apply {
                    val sz = dp(ctx, 16)
                    layoutParams = LinearLayout.LayoutParams(sz, sz).apply {
                        if (text.isNotEmpty()) rightMargin = dp(ctx, 7)
                    }
                }
            }
            iconView?.let { addView(it) }
            if (text.isNotEmpty()) {
                val tv = label(ctx, text, sp = sp, color = normalText, bold = primary).apply {
                    if (maxTextWidthDp > 0) maxWidth = dp(ctx, maxTextWidthDp)
                }
                addView(tv, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
            }
            focusScale(this, 1.035f) { hasFocus ->
                val c = if (hasFocus) focusText else if (isSelected && !primary && !danger) BAMBOO_400 else normalText
                for (i in 0 until childCount) {
                    when (val child = getChildAt(i)) {
                        is TvIconView -> child.setTint(c)
                        is TextView -> child.setTextColor(c)
                    }
                }
            }
        }
    }

    fun setPillSelected(btn: LinearLayout, selected: Boolean) {
        btn.isSelected = selected
        val c = when {
            btn.hasFocus() -> PAPER_50
            selected -> BAMBOO_400
            else -> PAPER_100
        }
        for (i in 0 until btn.childCount) {
            when (val child = btn.getChildAt(i)) {
                is TvIconView -> child.setTint(c)
                is TextView -> child.setTextColor(c)
            }
        }
    }

    /**
     * Vertical LinearLayout where child 0 (sticky header / filter drawer) is drawn AFTER child 1..N (scrolling content),
     * preventing any GPU/ROM quirk from ever painting scrolled content on top of headers or secondary filter bars.
     */
    fun headerFirstColumn(ctx: Context): LinearLayout = HeaderFirstLinearLayout(ctx)

    private fun tuneBaseGrid(ctx: Context, grid: BaseGridView, vertical: Boolean, cacheSize: Int, prefetchCount: Int) {
        grid.clipChildren = false
        grid.clipToPadding = false
        grid.itemAnimator = null
        grid.setAnimateChildLayout(false)
        grid.setSmoothScrollSpeedFactor(if (vertical) 0.55f else 0.6f)
        grid.setSmoothScrollMaxPendingMoves(12)
        grid.setItemViewCacheSize(cacheSize)
        grid.setInitialPrefetchItemCount(prefetchCount)
        if (vertical) {
            grid.setOnGenericMotionListener { v, event ->
                if (event.action == MotionEvent.ACTION_SCROLL) {
                    val vScroll = event.getAxisValue(MotionEvent.AXIS_VSCROLL)
                    if (vScroll != 0f) {
                        (v as RecyclerView).smoothScrollBy(0, (-vScroll * dp(ctx, 108)).toInt())
                        return@setOnGenericMotionListener true
                    }
                }
                false
            }
        }
    }

    fun verticalGrid(ctx: Context, parent: ViewGroup? = null): VerticalGridView =
        (LayoutInflater.from(ctx).inflate(R.layout.tv_vertical_grid, parent, false) as VerticalGridView).apply {
            setHasFixedSize(true)
            tuneBaseGrid(ctx, this, vertical = true, cacheSize = 14, prefetchCount = 6)
        }

    fun bindGridHeaderNavigation(
        grid: VerticalGridView,
        columns: Int,
        onReachEnd: ((position: Int, isNewPress: Boolean) -> Unit)? = null,
        header: () -> View?,
    ) {
        grid.setNumColumns(columns)
        alignLowEdge(grid, grid.paddingTop)
        var preferredColumn: Int? = null
        var pendingPosition: Int? = null
        var framePosition: Int? = null
        val applyPosition = Runnable {
            val target = framePosition
            framePosition = null
            if (target != null && grid.hasFocus() && target in 0 until (grid.adapter?.itemCount ?: 0)) {
                grid.setSelectedPositionSmooth(target)
            }
        }
        fun clearPendingPosition() {
            grid.removeCallbacks(applyPosition)
            framePosition = null
            pendingPosition = null
        }
        var focusObserver: ViewTreeObserver? = null
        val focusListener = ViewTreeObserver.OnGlobalFocusChangeListener { _, focus ->
            // Leanback briefly focuses the grid itself while a remote target is
            // being attached. That transition must retain the intended column.
            if (focus != null && focus !== grid && grid.findContainingViewHolder(focus) == null) {
                preferredColumn = null
                clearPendingPosition()
            }
        }
        grid.addOnAttachStateChangeListener(object : View.OnAttachStateChangeListener {
            override fun onViewAttachedToWindow(v: View) {
                focusObserver = grid.viewTreeObserver.also { it.addOnGlobalFocusChangeListener(focusListener) }
            }
            override fun onViewDetachedFromWindow(v: View) {
                focusObserver?.takeIf { it.isAlive }?.removeOnGlobalFocusChangeListener(focusListener)
                focusObserver = null
                preferredColumn = null
                clearPendingPosition()
            }
        })
        grid.setOnKeyInterceptListener { event ->
            if (event.action != KeyEvent.ACTION_DOWN || !grid.hasFocus()) {
                return@setOnKeyInterceptListener false
            }
            val count = grid.adapter?.itemCount ?: 0
            val actual = grid.findFocus()?.let { grid.findContainingViewHolder(it)?.bindingAdapterPosition }
            val idle = grid.scrollState == RecyclerView.SCROLL_STATE_IDLE
            if (framePosition == null && idle && actual == pendingPosition) pendingPosition = null
            val position = pendingPosition?.takeIf { it in 0 until count }
                ?: actual?.takeIf { it in 0 until count } ?: grid.selectedPosition
            if (position !in 0 until count) return@setOnKeyInterceptListener false
            val target = when (event.keyCode) {
                KeyEvent.KEYCODE_DPAD_UP -> {
                    val column = preferredColumn ?: (position % columns).also { preferredColumn = it }
                    if (position < columns) {
                        if (actual != position || !idle || framePosition != null) {
                            clearPendingPosition()
                            grid.stopScroll()
                            grid.setSelectedPosition(position)
                        } else {
                            val firstRowCard = grid.findViewHolderForAdapterPosition(position)?.itemView
                            if (firstRowCard != null) grid.scrollBy(0, firstRowCard.top - grid.paddingTop)
                            header()?.requestFocus()
                        }
                        return@setOnKeyInterceptListener true
                    }
                    (position / columns - 1) * columns + column
                }
                KeyEvent.KEYCODE_DPAD_DOWN -> {
                    val column = preferredColumn ?: (position % columns).also { preferredColumn = it }
                    val nextRow = (position / columns + 1) * columns
                    if (nextRow >= count) {
                        if (framePosition == null && idle && actual == position) {
                            onReachEnd?.invoke(position, event.repeatCount == 0)
                        }
                        position
                    } else minOf(nextRow + column, count - 1)
                }
                KeyEvent.KEYCODE_DPAD_LEFT -> (if (position % columns == 0) position else position - 1).also { preferredColumn = it % columns }
                KeyEvent.KEYCODE_DPAD_RIGHT -> (if (position % columns == columns - 1) position else minOf(position + 1, count - 1)).also { preferredColumn = it % columns }
                else -> return@setOnKeyInterceptListener false
            }
            if (target != position) {
                pendingPosition = target
                if (framePosition == null) grid.postOnAnimation(applyPosition)
                framePosition = target
            }
            true
        }
    }

    fun homeVerticalList(ctx: Context, parent: ViewGroup? = null): VerticalGridView =
        (LayoutInflater.from(ctx).inflate(R.layout.tv_home_list, parent, false) as VerticalGridView).apply {
            setNumColumns(1)
            setHasFixedSize(true)
            tuneBaseGrid(ctx, this, vertical = true, cacheSize = 6, prefetchCount = 4)
        }

    fun horizontalGrid(ctx: Context, parent: ViewGroup? = null): HorizontalGridView =
        (LayoutInflater.from(ctx).inflate(R.layout.tv_horizontal_grid, parent, false) as HorizontalGridView).apply {
            tuneBaseGrid(ctx, this, vertical = false, cacheSize = 8, prefetchCount = 7)
        }

    /**
     * Wraps a HorizontalGridView inside an overscan-safe clipped frame [pageH - inset .. screenW - pageH + inset]
     * so focused edge items keep their full 1.035x halo while off-screen items never bleed into the TV bezel.
     */
    fun framedHorizontalRow(
        ctx: Context,
        grid: HorizontalGridView,
        rowHeightPx: Int,
        padTopPx: Int,
        padBottomPx: Int,
    ): FrameLayout {
        val m = metrics(ctx)
        val inset = m.rowFocusInset
        val marginH = (m.pageH - inset).coerceAtLeast(0)
        alignLowEdge(grid, inset)
        grid.setPadding(inset, padTopPx, inset, padBottomPx)
        return FrameLayout(ctx).apply {
            clipChildren = true
            clipToPadding = true
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, rowHeightPx)
            val glp = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT).apply {
                leftMargin = marginH
                rightMargin = marginH
            }
            addView(grid, glp)
        }
    }

    fun configureScrollView(ctx: Context, scroll: ScrollView) {
        scroll.setOnGenericMotionListener { v, event ->
            if (event.action == MotionEvent.ACTION_SCROLL) {
                val vScroll = event.getAxisValue(MotionEvent.AXIS_VSCROLL)
                if (vScroll != 0f) {
                    (v as ScrollView).smoothScrollBy(0, (-vScroll * dp(ctx, 108)).toInt())
                    return@setOnGenericMotionListener true
                }
            }
            false
        }
    }

    fun alignLowEdge(grid: BaseGridView, offsetPx: Int) {
        grid.setWindowAlignment(BaseGridView.WINDOW_ALIGN_LOW_EDGE)
        grid.setWindowAlignmentOffset(offsetPx)
        grid.setWindowAlignmentOffsetPercent(BaseGridView.WINDOW_ALIGN_OFFSET_PERCENT_DISABLED)
        grid.setItemAlignmentOffset(0)
        grid.setItemAlignmentOffsetPercent(0f)
    }

    fun focusScrollView(ctx: Context): ScrollView = object : ScrollView(ctx) {
        private val focusRect = Rect()
        private val margin = dp(ctx, 12)

        override fun computeScrollDeltaToGetChildRectOnScreen(rect: Rect): Int {
            focusRect.set(rect)
            focusRect.top -= margin
            focusRect.bottom += margin
            return super.computeScrollDeltaToGetChildRectOnScreen(focusRect)
        }
    }

    fun navPill(ctx: Context, text: String): TextView {
        return TextView(ctx).apply {
            this.text = text
            setTextSize(TypedValue.COMPLEX_UNIT_PX, 13.5f * unit(ctx))
            gravity = Gravity.CENTER
            maxLines = 1
            isFocusable = true
            isFocusableInTouchMode = true
            isClickable = true
            setPadding(dp(ctx, 14), dp(ctx, 6), dp(ctx, 14), dp(ctx, 6))
            background = focusBox(
                ctx,
                normalBg = Color.TRANSPARENT,
                focusedBg = FILL_2,
                normalStroke = 0,
                selectedBg = BAMBOO_SOFT,
                selectedStroke = BAMBOO_LINE,
                radiusDp = 999,
            )
            setTextColor(
                ColorStateList(
                    arrayOf(intArrayOf(android.R.attr.state_focused), intArrayOf(android.R.attr.state_selected), intArrayOf()),
                    intArrayOf(PAPER_50, BAMBOO_400, PAPER_70),
                )
            )
            focusScale(this, 1.035f)
        }
    }

    fun sectionHeader(ctx: Context, title: String, padH: Int, padBottom: Int = dp(ctx, 10), trailing: View? = null): LinearLayout {
        return LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            clipChildren = false
            clipToPadding = false
            setPadding(padH, 0, padH, padBottom)
            addView(View(ctx).apply {
                background = box(BAMBOO_400, radiusDp = 2, ctx = ctx)
                layoutParams = LinearLayout.LayoutParams(dp(ctx, 3), dp(ctx, 16)).apply {
                    rightMargin = dp(ctx, 9)
                }
            })
            addView(label(ctx, title, sp = 17.5f, color = PAPER_100, bold = true), LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            if (trailing != null) addView(trailing)
        }
    }

    fun hairline(ctx: Context): View = View(ctx).apply {
        setBackgroundColor(LINE)
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 1)
    }

    fun emptyOrErrorBox(
        ctx: Context,
        message: String,
        retryLabel: String? = null,
        focusRetry: Boolean = false,
        onRetry: (() -> Unit)? = null,
    ): LinearLayout {
        return LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(dp(ctx, 32), dp(ctx, 32), dp(ctx, 32), dp(ctx, 32))
            layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT, Gravity.CENTER)
            val icon = TvIconView(ctx, TvIcon.ALERT, PAPER_52).apply {
                val sz = dp(ctx, 38)
                layoutParams = LinearLayout.LayoutParams(sz, sz).apply {
                    gravity = Gravity.CENTER_HORIZONTAL
                    bottomMargin = dp(ctx, 12)
                }
            }
            addView(icon)
            addView(label(ctx, message, sp = 15f, color = PAPER_70, maxLines = 2).apply {
                gravity = Gravity.CENTER
                maxWidth = dp(ctx, 520)
                layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                    gravity = Gravity.CENTER_HORIZONTAL
                    bottomMargin = if (retryLabel != null) dp(ctx, 16) else 0
                }
            })
            if (retryLabel != null && onRetry != null) {
                val retry = pillButton(ctx, retryLabel).apply {
                    layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                        gravity = Gravity.CENTER_HORIZONTAL
                    }
                    setOnClickListener { onRetry() }
                }
                addView(retry)
                // A full-page error replaces the content with no focused control. Give the
                // remote user a visible target immediately; screens with a persistent input
                // or header keep their focus and leave this opt-in off.
                if (focusRetry) retry.post { if (isAttachedToWindow && retry.isShown) retry.requestFocus() }
            }
        }
    }

    fun loadingBox(ctx: Context, text: String = Copy.Extra.LOADING): FrameLayout {
        val outer = FrameLayout(ctx).apply {
            layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        }
        val card = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(dp(ctx, 28), dp(ctx, 24), dp(ctx, 28), dp(ctx, 20))
            background = box(INK_900, LINE, radiusDp = 18, ctx = ctx)
            layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER)
        }
        card.addView(ProgressBar(ctx).apply {
            indeterminateTintList = ColorStateList.valueOf(BAMBOO_400)
            val sz = dp(ctx, 32)
            layoutParams = LinearLayout.LayoutParams(sz, sz).apply {
                gravity = Gravity.CENTER_HORIZONTAL
                bottomMargin = dp(ctx, 12)
            }
        })
        card.addView(label(ctx, text, sp = 13.5f, color = PAPER_70).apply {
            gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                gravity = Gravity.CENTER_HORIZONTAL
            }
        })
        outer.addView(card)
        return outer
    }
}

private class HeaderFirstLinearLayout(ctx: Context) : LinearLayout(ctx) {
    init {
        orientation = VERTICAL
        setBackgroundColor(Theme.INK_950)
        setChildrenDrawingOrderEnabled(true)
    }

    override fun getChildDrawingOrder(childCount: Int, i: Int): Int {
        if (childCount <= 1) return i
        // Draw child 1..N-1 (scrolling viewport) first, and child 0 (sticky header / filter bar) last on top
        return if (i == childCount - 1) 0 else i + 1
    }
}

class FixedSizeImageView(context: Context) : ImageView(context) {
    private var suppressLayout = false

    override fun hasOverlappingRendering(): Boolean = false

    override fun setImageDrawable(drawable: Drawable?) {
        val lp = layoutParams
        suppressLayout = width > 0 && height > 0 &&
            lp != null &&
            lp.width == ViewGroup.LayoutParams.MATCH_PARENT &&
            lp.height == ViewGroup.LayoutParams.MATCH_PARENT
        super.setImageDrawable(drawable)
        suppressLayout = false
    }

    override fun requestLayout() {
        if (!suppressLayout) super.requestLayout()
    }
}

class SwitchView(ctx: Context, private var checked: Boolean) : View(ctx) {
    private val w = Theme.dp(ctx, 44).toFloat()
    private val h = Theme.dp(ctx, 24).toFloat()
    private val rect = RectF(0f, 0f, w, h)
    private val trackPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val strokePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = Theme.dp(ctx, 1).toFloat().coerceAtLeast(1f)
    }
    private val thumbPaint = Paint(Paint.ANTI_ALIAS_FLAG)

    init {
        layoutParams = LinearLayout.LayoutParams(w.toInt(), h.toInt())
        syncColors()
    }

    fun setChecked(next: Boolean) {
        if (checked == next) return
        checked = next
        syncColors()
        invalidate()
    }

    private fun syncColors() {
        trackPaint.color = if (checked) Theme.BAMBOO_400 else Theme.INK_800
        strokePaint.color = if (checked) Theme.BAMBOO_400 else Theme.LINE_2
        thumbPaint.color = if (checked) Theme.INK_950 else Theme.PAPER_70
    }

    override fun onDraw(canvas: Canvas) {
        val r = h / 2f
        rect.set(0f, 0f, w, h)
        canvas.drawRoundRect(rect, r, r, trackPaint)
        canvas.drawRoundRect(rect, r, r, strokePaint)
        val thumbR = h * 0.34f
        val cx = if (checked) w - r else r
        canvas.drawCircle(cx, r, thumbR, thumbPaint)
    }
}

class MediaCardView(ctx: Context, private val wide: Boolean) : LinearLayout(ctx) {
    private val m = Theme.metrics(ctx)
    private val outerWidth = if (wide) m.wideCardW else m.posterCardW
    private val imgWidth = if (wide) m.wideImgW else m.posterImgW
    private val imgHeight = if (wide) m.wideImgH else m.posterImgH
    private val imageContainer = FrameLayout(ctx)
    private val fallbackTv = Theme.label(ctx, sp = 12.5f, color = Theme.PAPER_52, maxLines = 2).apply {
        gravity = Gravity.CENTER
        visibility = View.INVISIBLE
        setPadding(Theme.dp(ctx, 10), Theme.dp(ctx, 10), Theme.dp(ctx, 10), Theme.dp(ctx, 10))
    }
    private val image = FixedSizeImageView(ctx)
    private val scoreBadge = TextView(ctx)
    private val statusBadge = TextView(ctx)
    private val progressBox = FrameLayout(ctx)
    private val progressFill = View(ctx)
    private val titleTv = Theme.label(ctx, sp = 13.5f, color = Theme.PAPER_100, bold = true, maxLines = 1)
    private val subTv = Theme.label(ctx, sp = 11.5f, color = Theme.PAPER_52, maxLines = 1)
    private var boundApp: PandaTvApp? = null
    private var boundImageUrl: String? = null

    init {
        orientation = LinearLayout.VERTICAL
        isFocusable = true
        isFocusableInTouchMode = true
        isClickable = true
        setPadding(m.cardPadH, m.cardPadTop, m.cardPadH, m.cardPadBottom)
        layoutParams = ViewGroup.MarginLayoutParams(outerWidth, ViewGroup.LayoutParams.WRAP_CONTENT)
        background = Theme.focusBox(ctx, normalBg = Color.TRANSPARENT, focusedBg = Theme.INK_850, normalStroke = 0, radiusDp = 14)

        imageContainer.apply {
            layoutParams = LayoutParams(imgWidth, imgHeight)
            background = Theme.box(Theme.INK_900, Theme.LINE, radiusDp = 10, ctx = ctx)
            clipToOutline = true
        }
        imageContainer.addView(fallbackTv, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        image.apply {
            layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            scaleType = ImageView.ScaleType.CENTER_CROP
        }
        imageContainer.addView(image)

        scoreBadge.apply {
            setTextSize(TypedValue.COMPLEX_UNIT_PX, 11f * Theme.unit(ctx))
            setTextColor(Theme.AMBER_400)
            typeface = android.graphics.Typeface.DEFAULT_BOLD
            visibility = View.INVISIBLE
            setPadding(Theme.dp(ctx, 6), Theme.dp(ctx, 2), Theme.dp(ctx, 6), Theme.dp(ctx, 2))
            background = Theme.box(0xD90E0D0B.toInt(), Theme.LINE, radiusDp = 6, ctx = ctx)
            layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.END).apply {
                setMargins(0, Theme.dp(ctx, 7), Theme.dp(ctx, 7), 0)
            }
        }
        imageContainer.addView(scoreBadge)

        statusBadge.apply {
            setTextSize(TypedValue.COMPLEX_UNIT_PX, 10.5f * Theme.unit(ctx))
            setTextColor(Theme.PAPER_70)
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
            maxWidth = (imgWidth - Theme.dp(ctx, 16)).coerceAtLeast(Theme.dp(ctx, 48))
            visibility = View.INVISIBLE
            setPadding(Theme.dp(ctx, 6), Theme.dp(ctx, 2), Theme.dp(ctx, 6), Theme.dp(ctx, 2))
            background = Theme.box(0xCC0E0D0B.toInt(), 0, radiusDp = 5, ctx = ctx)
            layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM or Gravity.START).apply {
                setMargins(Theme.dp(ctx, 7), 0, Theme.dp(ctx, 7), Theme.dp(ctx, 7))
            }
        }
        imageContainer.addView(statusBadge)

        progressBox.apply {
            visibility = View.INVISIBLE
            background = Theme.box(0x770E0D0B, Theme.LINE, radiusDp = 99, ctx = ctx)
            val barH = Theme.dp(ctx, 4)
            val inset = Theme.dp(ctx, 8)
            layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, barH, Gravity.BOTTOM).apply {
                setMargins(inset, 0, inset, inset)
            }
        }
        progressFill.apply {
            background = Theme.box(Theme.BAMBOO_400, 0, radiusDp = 99, ctx = ctx)
            layoutParams = FrameLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, Gravity.START)
        }
        progressBox.addView(progressFill)
        imageContainer.addView(progressBox)
        addView(imageContainer)

        val textInset = Theme.dp(ctx, 3)
        titleTv.apply {
            setPadding(textInset, 0, textInset, 0)
            // Leanback lays out staggered columns when font fallback changes a card's
            // measured height. Reserve the same line box for every title and subtitle.
            gravity = Gravity.CENTER_VERTICAL
            layoutParams = LayoutParams(imgWidth, Theme.sp(ctx, 21f)).apply {
                topMargin = Theme.dp(ctx, 8)
            }
        }
        subTv.apply {
            setPadding(textInset, 0, textInset, 0)
            gravity = Gravity.CENTER_VERTICAL
            layoutParams = LayoutParams(imgWidth, Theme.sp(ctx, 18f)).apply {
                topMargin = Theme.dp(ctx, 3)
            }
        }
        addView(titleTv)
        addView(subTv)
        Theme.focusScale(this, 1.035f) { hasFocus ->
            titleTv.setTextColor(if (hasFocus) Theme.PAPER_50 else Theme.PAPER_100)
            subTv.setTextColor(if (hasFocus) Theme.PAPER_70 else Theme.PAPER_52)
        }
    }

    fun bind(app: PandaTvApp, item: MediaItem, subtitleOverride: String? = null, progressPct: Int? = null) {
        tag = item.id
        val url = if (wide) Rules.wideImage(item) else item.poster
        boundApp = app
        boundImageUrl = url
        if (fallbackTv.text.toString() != item.title) fallbackTv.text = item.title
        if (url == null) {
            app.images.clear(image)
            if (fallbackTv.visibility != View.VISIBLE) fallbackTv.visibility = View.VISIBLE
        } else {
            if (fallbackTv.visibility != View.INVISIBLE) fallbackTv.visibility = View.INVISIBLE
            app.images.load(image, url, imgWidth, imgHeight) { ok ->
                val vis = if (ok) View.INVISIBLE else View.VISIBLE
                if (fallbackTv.visibility != vis) fallbackTv.visibility = vis
            }
        }

        val score = Rules.scoreText(item)
        if (score != null) {
            if (scoreBadge.text.toString() != score) scoreBadge.text = score
            if (scoreBadge.visibility != View.VISIBLE) scoreBadge.visibility = View.VISIBLE
        } else if (scoreBadge.visibility != View.INVISIBLE) {
            scoreBadge.visibility = View.INVISIBLE
        }

        val status = if (progressPct == null) Rules.statusText(item) else null
        if (status != null) {
            if (statusBadge.text.toString() != status) statusBadge.text = status
            if (statusBadge.visibility != View.VISIBLE) statusBadge.visibility = View.VISIBLE
        } else if (statusBadge.visibility != View.INVISIBLE) {
            statusBadge.visibility = View.INVISIBLE
        }

        if (titleTv.text.toString() != item.title) titleTv.text = item.title
        val sub = subtitleOverride ?: Rules.cardSub(item)
        if (sub != null) {
            if (subTv.text.toString() != sub) subTv.text = sub
            if (subTv.visibility != View.VISIBLE) subTv.visibility = View.VISIBLE
        } else {
            // Keep INVISIBLE instead of GONE so every card in a row has identical outer height & focus border
            if (subTv.text.isNotEmpty()) subTv.text = ""
            if (subTv.visibility != View.INVISIBLE) subTv.visibility = View.INVISIBLE
        }

        if (progressPct != null) {
            if (progressBox.visibility != View.VISIBLE) progressBox.visibility = View.VISIBLE
            val trackW = (imgWidth - Theme.dp(context, 16)).coerceAtLeast(1)
            val fillW = (trackW * progressPct / 100).coerceAtLeast(Theme.dp(context, 6))
            val flp = progressFill.layoutParams as FrameLayout.LayoutParams
            if (flp.width != fillW) {
                flp.width = fillW
                progressFill.layoutParams = flp
            }
        } else if (progressBox.visibility != View.INVISIBLE) {
            progressBox.visibility = View.INVISIBLE
        }
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        boundApp?.images?.load(image, boundImageUrl, imgWidth, imgHeight) { ok ->
            fallbackTv.visibility = if (ok) View.INVISIBLE else View.VISIBLE
        }
    }

    override fun onDetachedFromWindow() {
        boundApp?.images?.cancelPending(image)
        super.onDetachedFromWindow()
    }
}
