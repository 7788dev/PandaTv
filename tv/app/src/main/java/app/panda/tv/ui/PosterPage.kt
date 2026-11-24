package app.panda.tv.ui

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import androidx.leanback.widget.VerticalGridView
import app.panda.tv.model.Copy

/** The footer has a fixed slot below the collection, so its state never covers a card. */
internal class PosterPageFooter(
    ctx: Context,
    private var grid: VerticalGridView,
    onRetry: () -> Unit,
) : LinearLayout(ctx) {
    private val metrics = Theme.metrics(ctx)
    private val message = Theme.label(ctx, sp = 13f, color = Theme.PAPER_70, maxLines = 1)
    val retry = Theme.pillButton(ctx, Copy.Action.RETRY, padH = 14, padV = 6)
    private val more = Theme.pillButton(ctx, Copy.Extra.LOAD_MORE, padH = 14, padV = 6)
    private var onMore: (() -> Unit)? = null
    val failed: Boolean get() = retry.visibility == VISIBLE
    private var departure: Int? = null

    fun bindGrid(target: VerticalGridView) { grid = target; departure = null }

    init {
        orientation = HORIZONTAL
        gravity = Gravity.CENTER
        clipChildren = false
        clipToPadding = false
        setPadding(metrics.pageH, 0, metrics.pageH, metrics.safeV)
        layoutParams = LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, metrics.safeV + Theme.dp(ctx, 43))
        addView(message)
        addView(retry, LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
            marginStart = Theme.dp(ctx, 14)
        })
        addView(more, LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginStart = Theme.dp(ctx, 14) })
        more.visibility = GONE
        message.accessibilityLiveRegion = ACCESSIBILITY_LIVE_REGION_POLITE
        retry.setOnKeyListener { _, code, event ->
            if (event.action == KeyEvent.ACTION_DOWN && code == KeyEvent.KEYCODE_DPAD_UP) {
                restoreCard()
                true
            } else if (event.action == KeyEvent.ACTION_DOWN && code == KeyEvent.KEYCODE_DPAD_RIGHT && more.visibility == VISIBLE) {
                more.requestFocus()
                true
            } else {
                code == KeyEvent.KEYCODE_DPAD_DOWN || code == KeyEvent.KEYCODE_DPAD_LEFT || code == KeyEvent.KEYCODE_DPAD_RIGHT
            }
        }
        retry.setOnClickListener {
            restoreCard()
            onRetry()
        }
        more.setOnKeyListener { _, code, event ->
            if (event.action == KeyEvent.ACTION_DOWN && code == KeyEvent.KEYCODE_DPAD_UP) { restoreCard(); true }
            else if (event.action == KeyEvent.ACTION_DOWN && code == KeyEvent.KEYCODE_DPAD_LEFT && retry.visibility == VISIBLE) { retry.requestFocus(); true }
            else code in setOf(KeyEvent.KEYCODE_DPAD_DOWN, KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_RIGHT)
        }
        more.setOnClickListener { restoreCard(); onMore?.invoke() }
        show()
    }

    fun show(text: String? = null, retryable: Boolean = false) {
        message.text = text.orEmpty()
        retry.visibility = if (retryable) VISIBLE else GONE
        visibility = if (text != null) VISIBLE else INVISIBLE
    }

    fun showMore(action: (() -> Unit)?) { onMore = action; more.visibility = if (action == null) GONE else VISIBLE }

    fun onGridEnd(position: Int, isNewPress: Boolean, loadMore: () -> Unit) {
        if (failed) {
            if (isNewPress && grid.hasFocus()) {
                departure = position
                retry.requestFocus()
            }
        } else {
            loadMore()
        }
    }

    private fun restoreCard() {
        val position = departure ?: grid.selectedPosition
        val target = grid.findViewHolderForAdapterPosition(position)?.itemView
        if (target?.requestFocus() != true) {
            grid.selectedPosition = position.coerceAtLeast(0)
            grid.requestFocus()
        }
    }
}

internal fun posterPageLoading(ctx: Context, grid: VerticalGridView): View = FrameLayout(ctx).apply {
    val metrics = Theme.metrics(ctx)
    val posterTop = grid.paddingTop + metrics.cardPadTop
    val skeleton = object : View(ctx) {
        private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        private val radius = Theme.dp(ctx, 10).toFloat()
        private val titleRadius = Theme.dp(ctx, 3).toFloat()

        override fun onDraw(canvas: Canvas) {
            super.onDraw(canvas)
            val stride = metrics.posterCardW + metrics.gridGapH
            val titleMargin = Theme.dp(ctx, 10)
            val titleHeight = Theme.dp(ctx, 9)
            val gap = Theme.dp(ctx, 7)
            var rowTop = posterTop.toFloat()
            while (rowTop < height) {
                for (column in 0 until 6) {
                    val left = (metrics.pageH + column * stride + metrics.cardPadH).toFloat()
                    val bottom = rowTop + metrics.posterImgH
                    paint.color = Theme.INK_850
                    canvas.drawRoundRect(left, rowTop, left + metrics.posterImgW, bottom, radius, radius, paint)
                    paint.color = Theme.LINE_2
                    val titleTop = bottom + titleMargin
                    canvas.drawRoundRect(left, titleTop, left + metrics.posterImgW * .75f, titleTop + titleHeight, titleRadius, titleRadius, paint)
                    val subTop = titleTop + titleHeight + gap
                    canvas.drawRoundRect(left, subTop, left + metrics.posterImgW * .45f, subTop + titleHeight, titleRadius, titleRadius, paint)
                }
                rowTop += metrics.posterRowH + metrics.gridGapV
            }
        }
    }
    addView(skeleton, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    addView(Theme.label(ctx, Copy.Extra.LOADING, sp = 14f, color = Theme.PAPER_100, bold = true).apply {
        setPadding(Theme.dp(ctx, 16), Theme.dp(ctx, 7), Theme.dp(ctx, 16), Theme.dp(ctx, 7))
        background = Theme.box(Theme.INK_900, Theme.LINE, radiusDp = 999, ctx = ctx)
    }, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER))
}
