package app.panda.tv.ui

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.view.View

class PandaLogoView(context: Context) : View(context) {
    private val earPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Theme.BAMBOO_400; style = Paint.Style.FILL }
    private val headPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Theme.PAPER_100; style = Paint.Style.FILL }
    private val inkPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Theme.INK_900; style = Paint.Style.FILL }
    private val rect = RectF()

    override fun onDraw(canvas: Canvas) {
        val s = minOf(width, height) / 64f
        canvas.save()
        canvas.translate((width - 64f * s) / 2f, (height - 64f * s) / 2f)
        canvas.scale(s, s)

        canvas.drawCircle(15.5f, 16.5f, 9.5f, earPaint)
        canvas.drawCircle(48.5f, 16.5f, 9.5f, earPaint)
        rect.set(7f, 13.5f, 57f, 58.5f)
        canvas.drawOval(rect, headPaint)

        canvas.save()
        canvas.rotate(26f, 21.6f, 35.2f)
        rect.set(21.6f - 6.1f, 35.2f - 8f, 21.6f + 6.1f, 35.2f + 8f)
        canvas.drawOval(rect, inkPaint)
        canvas.restore()

        canvas.save()
        canvas.rotate(-26f, 42.4f, 35.2f)
        rect.set(42.4f - 6.1f, 35.2f - 8f, 42.4f + 6.1f, 35.2f + 8f)
        canvas.drawOval(rect, inkPaint)
        canvas.restore()

        canvas.drawCircle(22.9f, 33.9f, 1.9f, headPaint)
        canvas.drawCircle(41.1f, 33.9f, 1.9f, headPaint)
        rect.set(32f - 3.4f, 45f - 2.3f, 32f + 3.4f, 45f + 2.3f)
        canvas.drawOval(rect, inkPaint)
        canvas.restore()
    }
}

enum class TvIcon {
    SEARCH, HEART, HISTORY, SETTINGS, PLAY, PAUSE, NEXT, FORWARD, REWIND,
    EPISODES, LINE, SPEED, QUALITY, CHEVRON_LEFT, CHEVRON_RIGHT, ALERT, REFRESH, TRASH, BACK
}

class TvIconView(context: Context, private var icon: TvIcon, tint: Int = Theme.PAPER_100) : View(context) {
    private val strokePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = tint
        style = Paint.Style.STROKE
        strokeWidth = 2f
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
    }
    private val fillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = tint
        style = Paint.Style.FILL
    }
    private val path = Path()
    private val rect = RectF()

    fun setIcon(next: TvIcon) {
        icon = next
        invalidate()
    }

    fun setTint(color: Int) {
        strokePaint.color = color
        fillPaint.color = color
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        val s = minOf(width, height) / 24f
        canvas.save()
        canvas.translate((width - 24f * s) / 2f, (height - 24f * s) / 2f)
        canvas.scale(s, s)
        strokePaint.strokeWidth = 2f

        when (icon) {
            TvIcon.SEARCH -> {
                canvas.drawCircle(11f, 11f, 7.5f, strokePaint)
                canvas.drawLine(16.5f, 16.5f, 21f, 21f, strokePaint)
            }
            TvIcon.HEART -> {
                path.reset()
                path.moveTo(12f, 20.5f)
                path.cubicTo(4f, 14.5f, 2.5f, 10f, 3f, 7.5f)
                path.cubicTo(3.5f, 4.5f, 6.5f, 3.5f, 9f, 4.5f)
                path.cubicTo(10.5f, 5.1f, 11.4f, 6.2f, 12f, 7.2f)
                path.cubicTo(12.6f, 6.2f, 13.5f, 5.1f, 15f, 4.5f)
                path.cubicTo(17.5f, 3.5f, 20.5f, 4.5f, 21f, 7.5f)
                path.cubicTo(21.5f, 10f, 20f, 14.5f, 12f, 20.5f)
                path.close()
                canvas.drawPath(path, strokePaint)
            }
            TvIcon.HISTORY -> {
                rect.set(3f, 3f, 21f, 21f)
                canvas.drawArc(rect, 160f, 270f, false, strokePaint)
                canvas.drawLine(3f, 4f, 3f, 8.5f, strokePaint)
                canvas.drawLine(3f, 8.5f, 7.5f, 8.5f, strokePaint)
                canvas.drawLine(12f, 7f, 12f, 12f, strokePaint)
                canvas.drawLine(12f, 12f, 16f, 14f, strokePaint)
            }
            TvIcon.SETTINGS -> {
                canvas.drawCircle(12f, 12f, 3.2f, strokePaint)
                canvas.drawCircle(12f, 12f, 8.2f, strokePaint)
                for (a in 0 until 8) {
                    val rad = Math.toRadians(a * 45.0)
                    val x1 = (12.0 + 8.5 * Math.cos(rad)).toFloat()
                    val y1 = (12.0 + 8.5 * Math.sin(rad)).toFloat()
                    val x2 = (12.0 + 10.5 * Math.cos(rad)).toFloat()
                    val y2 = (12.0 + 10.5 * Math.sin(rad)).toFloat()
                    canvas.drawLine(x1, y1, x2, y2, strokePaint)
                }
            }
            TvIcon.PLAY -> {
                path.reset()
                path.moveTo(7.5f, 5f)
                path.lineTo(19f, 12f)
                path.lineTo(7.5f, 19f)
                path.close()
                canvas.drawPath(path, fillPaint)
            }
            TvIcon.PAUSE -> {
                rect.set(6f, 4.5f, 10.2f, 19.5f)
                canvas.drawRoundRect(rect, 1.2f, 1.2f, fillPaint)
                rect.set(13.8f, 4.5f, 18f, 19.5f)
                canvas.drawRoundRect(rect, 1.2f, 1.2f, fillPaint)
            }
            TvIcon.NEXT -> {
                path.reset()
                path.moveTo(4.5f, 5.5f)
                path.lineTo(15f, 12f)
                path.lineTo(4.5f, 18.5f)
                path.close()
                canvas.drawPath(path, fillPaint)
                rect.set(17.2f, 5f, 20f, 19f)
                canvas.drawRoundRect(rect, 1f, 1f, fillPaint)
            }
            TvIcon.FORWARD -> drawArrowPair(canvas, false)
            TvIcon.REWIND -> drawArrowPair(canvas, true)
            TvIcon.EPISODES -> {
                canvas.drawLine(3f, 5.5f, 20f, 5.5f, strokePaint)
                canvas.drawLine(3f, 12f, 11f, 12f, strokePaint)
                canvas.drawLine(3f, 18.5f, 11f, 18.5f, strokePaint)
                path.reset()
                path.moveTo(15f, 11.5f); path.lineTo(21f, 15.2f); path.lineTo(15f, 19f); path.close()
                canvas.drawPath(path, fillPaint)
            }
            TvIcon.LINE -> {
                canvas.drawLine(4f, 6f, 20f, 6f, strokePaint)
                canvas.drawLine(4f, 12f, 20f, 12f, strokePaint)
                canvas.drawLine(4f, 18f, 20f, 18f, strokePaint)
                canvas.drawCircle(8f, 6f, 2f, fillPaint)
                canvas.drawCircle(16f, 12f, 2f, fillPaint)
                canvas.drawCircle(10f, 18f, 2f, fillPaint)
            }
            TvIcon.SPEED -> {
                rect.set(3f, 4f, 21f, 22f)
                canvas.drawArc(rect, 200f, 140f, false, strokePaint)
                canvas.drawLine(12f, 14f, 16.5f, 9.5f, strokePaint)
            }
            TvIcon.QUALITY -> {
                rect.set(3f, 5f, 21f, 19f)
                canvas.drawRoundRect(rect, 2f, 2f, strokePaint)
                canvas.drawLine(7.5f, 9f, 7.5f, 15f, strokePaint)
                canvas.drawLine(11f, 9f, 11f, 15f, strokePaint)
                canvas.drawLine(7.5f, 12f, 11f, 12f, strokePaint)
                canvas.drawLine(14.5f, 9f, 14.5f, 15f, strokePaint)
                rect.set(12.5f, 9f, 17.5f, 15f)
                canvas.drawArc(rect, -90f, 180f, false, strokePaint)
            }
            TvIcon.CHEVRON_LEFT -> {
                canvas.drawLine(15f, 6f, 9f, 12f, strokePaint)
                canvas.drawLine(9f, 12f, 15f, 18f, strokePaint)
            }
            TvIcon.CHEVRON_RIGHT -> {
                canvas.drawLine(9f, 6f, 15f, 12f, strokePaint)
                canvas.drawLine(15f, 12f, 9f, 18f, strokePaint)
            }
            TvIcon.ALERT -> {
                canvas.drawCircle(12f, 12f, 9.5f, strokePaint)
                canvas.drawLine(12f, 8f, 12f, 13f, strokePaint)
                canvas.drawCircle(12f, 16.3f, 0.9f, fillPaint)
            }
            TvIcon.REFRESH -> {
                rect.set(3.5f, 3.5f, 20.5f, 20.5f)
                canvas.drawArc(rect, 20f, 300f, false, strokePaint)
                canvas.drawLine(20.5f, 4f, 20.5f, 9f, strokePaint)
                canvas.drawLine(15.5f, 9f, 20.5f, 9f, strokePaint)
            }
            TvIcon.TRASH -> {
                canvas.drawLine(4f, 6f, 20f, 6f, strokePaint)
                canvas.drawLine(9f, 3.5f, 15f, 3.5f, strokePaint)
                rect.set(6f, 6f, 18f, 20f)
                canvas.drawRoundRect(rect, 1.5f, 1.5f, strokePaint)
                canvas.drawLine(10f, 10f, 10f, 16f, strokePaint)
                canvas.drawLine(14f, 10f, 14f, 16f, strokePaint)
            }
            TvIcon.BACK -> {
                canvas.drawLine(19f, 12f, 5f, 12f, strokePaint)
                canvas.drawLine(11f, 6f, 5f, 12f, strokePaint)
                canvas.drawLine(11f, 18f, 5f, 12f, strokePaint)
            }
        }
        canvas.restore()
    }

    private fun drawArrowPair(canvas: Canvas, reversed: Boolean) {
        if (reversed) {
            canvas.save()
            canvas.scale(-1f, 1f, 12f, 12f)
        }
        path.reset()
        path.moveTo(4f, 6.5f); path.lineTo(11f, 12f); path.lineTo(4f, 17.5f); path.close()
        canvas.drawPath(path, fillPaint)
        path.reset()
        path.moveTo(12.5f, 6.5f); path.lineTo(19.5f, 12f); path.lineTo(12.5f, 17.5f); path.close()
        canvas.drawPath(path, fillPaint)
        if (reversed) canvas.restore()
    }
}
