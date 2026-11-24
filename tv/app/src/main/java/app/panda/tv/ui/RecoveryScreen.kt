package app.panda.tv.ui

import android.content.Context
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import app.panda.tv.model.Copy

class RecoveryScreen(ctx: Context, nav: Navigator, private val onRecovered: () -> Unit) : Screen(ctx, nav) {
    override val showTopBar = false
    private var destroyed = false
    private val root = FrameLayout(ctx).apply { setBackgroundColor(Theme.INK_950) }
    private val actions = ArrayList<View>()
    override val view: View get() = root

    init {
        val metrics = Theme.metrics(ctx)
        val card = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(Theme.dp(ctx, 28), Theme.dp(ctx, 28), Theme.dp(ctx, 28), Theme.dp(ctx, 28))
            background = Theme.box(Theme.INK_900, Theme.LINE, radiusDp = 18, ctx = ctx)
        }
        card.addView(Theme.label(ctx, Copy.Extra.STATE_CORRUPT, sp = 22f, color = Theme.PAPER_100, bold = true))
        card.addView(Theme.label(ctx, Copy.Extra.RECOVERY_DESCRIPTION, sp = 14f, color = Theme.PAPER_70, maxLines = 4), LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
            topMargin = Theme.dp(ctx, 16); bottomMargin = Theme.dp(ctx, 20)
        })
        val row = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL; clipChildren = false }
        fun button(label: String, backup: Boolean) {
            val control = Theme.pillButton(ctx, label, primary = backup, danger = !backup).apply {
                setOnClickListener {
                    nav.confirm(if (backup) Copy.Extra.RESTORE_CONFIRM else Copy.Extra.RESET_CONFIRM, label, destructive = !backup) {
                        actions.forEach { it.isEnabled = false }
                        nav.app.userWriter.recover(backup) { result ->
                            if (destroyed) return@recover
                            result.fold(onSuccess = { onRecovered() }, onFailure = {
                                actions.forEach { it.isEnabled = true }
                                nav.toast(Copy.Extra.SAVE_ERROR)
                            })
                        }
                    }
                }
            }
            actions.add(control)
            row.addView(control, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { rightMargin = Theme.dp(ctx, 16) })
        }
        if (nav.app.userStore.recovery().canRestore) button(Copy.Extra.RESTORE_BACKUP, true)
        button(Copy.Extra.RESET_DATA, false)
        card.addView(row)
        root.addView(card, FrameLayout.LayoutParams(minOf(metrics.innerW, Theme.dp(ctx, 620)), ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER))
        root.post { actions.firstOrNull()?.requestFocus() }
    }

    override fun onDestroy() { destroyed = true }
}
