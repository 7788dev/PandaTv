package app.panda.tv.ui

import android.content.Context
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import app.panda.tv.model.Constants
import app.panda.tv.model.Copy
import app.panda.tv.model.Rules
import app.panda.tv.model.StateAction

class SettingsScreen(ctx: Context, nav: Navigator) : Screen(ctx, nav) {
    override val activeTab: String? = null

    private val m = Theme.metrics(ctx)
    private val scroll = ScrollView(ctx).apply {
        isFocusable = false
        isVerticalScrollBarEnabled = false
        clipChildren = true
        clipToPadding = false
        setBackgroundColor(Theme.INK_950)
    }
    private val outer = FrameLayout(ctx).apply {
        clipChildren = false
        clipToPadding = false
        setPadding(m.pageH, Theme.dp(ctx, 18), m.pageH, Theme.dp(ctx, 48))
    }
    private val col = LinearLayout(ctx).apply {
        orientation = LinearLayout.VERTICAL
        clipChildren = false
        clipToPadding = false
        val colW = minOf(m.innerW, Theme.dp(ctx, 740))
        layoutParams = FrameLayout.LayoutParams(colW, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.CENTER_HORIZONTAL)
    }

    private lateinit var autoNextSwitch: SwitchView
    private lateinit var skipIntroSwitch: SwitchView
    private lateinit var qualityValueTv: TextView
    private lateinit var speedValueTv: TextView
    private lateinit var firstRow: LinearLayout

    override val view: View get() = scroll

    init {
        Theme.configureScrollView(ctx, scroll)
        outer.addView(col)
        scroll.addView(outer, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        buildContent()
    }

    override fun onShown() {
        syncValues()
    }

    private fun bindScrollTop(v: View) {
        val prev = v.onFocusChangeListener
        v.setOnFocusChangeListener { target, hasFocus ->
            prev?.onFocusChange(target, hasFocus)
            if (hasFocus && scroll.scrollY > 0) {
                scroll.smoothScrollTo(0, 0)
            }
        }
    }

    private fun buildContent() {
        val s = nav.app.userStore.get().settings

        val head = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            clipChildren = false
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                bottomMargin = Theme.dp(ctx, 14)
            }
        }
        head.addView(Theme.label(ctx, Copy.SettingsCopy.TITLE, sp = 22f, color = Theme.PAPER_100, bold = true), LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        val backBtn = Theme.pillButton(ctx, Copy.Action.BACK, icon = TvIcon.BACK, padH = 15, padV = 7, sp = 13.5f).apply {
            setOnKeyListener { _, keyCode, event ->
                if (event.action == KeyEvent.ACTION_DOWN && keyCode == KeyEvent.KEYCODE_DPAD_UP) {
                    nav.focusTopBar()
                    true
                } else false
            }
            setOnClickListener { nav.back() }
        }
        bindScrollTop(backBtn)
        head.addView(backBtn)
        col.addView(head)

        col.addView(sectionLabel(Copy.SettingsCopy.PLAYBACK))

        autoNextSwitch = SwitchView(ctx, s.autoNext)
        firstRow = rowShell(Copy.SettingsCopy.AUTO_NEXT, trailing = autoNextSwitch) {
            val cur = nav.app.userStore.get().settings
            nav.app.userStore.dispatch(StateAction.UpdateSettings(autoNext = !cur.autoNext))
            syncValues()
        }
        bindScrollTop(firstRow)
        col.addView(firstRow)

        skipIntroSwitch = SwitchView(ctx, s.skipIntro)
        col.addView(rowShell(Copy.SettingsCopy.SKIP_INTRO, trailing = skipIntroSwitch) {
            val cur = nav.app.userStore.get().settings
            nav.app.userStore.dispatch(StateAction.UpdateSettings(skipIntro = !cur.skipIntro))
            syncValues()
        })

        qualityValueTv = Theme.label(ctx, s.quality.label, sp = 14f, color = Theme.PAPER_70, bold = true)
        col.addView(rowShell(Copy.SettingsCopy.QUALITY, trailing = qualityValueTv) {
            val cur = nav.app.userStore.get().settings
            val idx = Constants.QUALITIES.indexOf(cur.quality)
            val next = Constants.QUALITIES[(idx + 1) % Constants.QUALITIES.size]
            nav.app.userStore.dispatch(StateAction.UpdateSettings(quality = next))
            syncValues()
        })

        speedValueTv = Theme.label(ctx, Rules.speedLabel(s.speed), sp = 14f, color = Theme.PAPER_70, bold = true)
        col.addView(rowShell(Copy.SettingsCopy.SPEED, trailing = speedValueTv) {
            val cur = nav.app.userStore.get().settings
            val idx = Constants.SPEEDS.indexOf(cur.speed)
            val next = Constants.SPEEDS[(idx + 1) % Constants.SPEEDS.size]
            nav.app.userStore.dispatch(StateAction.UpdateSettings(speed = next))
            syncValues()
        })

        col.addView(sectionLabel(Copy.SettingsCopy.DATA))
        col.addView(rowShell(Copy.SettingsCopy.CLEAR_HISTORY, trailing = Theme.label(ctx, Copy.Action.CLEAR, sp = 14f, color = Theme.CINNABAR_400, bold = true), danger = true) {
            nav.confirm(Copy.Me.CLEAR_HISTORY_TITLE, Copy.Action.CLEAR, destructive = true) {
                nav.app.userStore.dispatch(StateAction.ClearHistory)
                nav.toast(Copy.Toast.CLEARED)
            }
        })
        col.addView(rowShell(Copy.SettingsCopy.CLEAR_SEARCHES, trailing = Theme.label(ctx, Copy.Action.CLEAR, sp = 14f, color = Theme.CINNABAR_400, bold = true), danger = true) {
            nav.confirm(Copy.SettingsCopy.CLEAR_SEARCHES_TITLE, Copy.Action.CLEAR, destructive = true) {
                nav.app.userStore.dispatch(StateAction.ClearSearches)
                nav.toast(Copy.Toast.CLEARED)
            }
        })

        @Suppress("DEPRECATION")
        val verName = runCatching { ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName }
            .getOrNull()?.takeIf { it.isNotBlank() } ?: "1.0.3"
        col.addView(sectionLabel(Copy.SettingsCopy.ABOUT))
        col.addView(rowShell(Copy.fmt(Copy.App.VERSION, "v" to verName), trailing = Theme.label(ctx, Copy.SettingsCopy.CHECK_UPDATE, sp = 14f, color = Theme.PAPER_70, bold = true)) {
            nav.toast(Copy.Extra.UPDATE_UNAVAILABLE)
        })

        firstRow.post { firstRow.requestFocus() }
    }

    private fun syncValues() {
        val s = nav.app.userStore.get().settings
        autoNextSwitch.setChecked(s.autoNext)
        skipIntroSwitch.setChecked(s.skipIntro)
        qualityValueTv.text = s.quality.label
        speedValueTv.text = Rules.speedLabel(s.speed)
    }

    private fun sectionLabel(title: String): TextView {
        return Theme.label(ctx, title, sp = 13.5f, color = Theme.BAMBOO_400, bold = true).apply {
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                topMargin = Theme.dp(ctx, 20)
                bottomMargin = Theme.dp(ctx, 10)
            }
        }
    }

    private fun rowShell(
        title: String,
        trailing: View,
        danger: Boolean = false,
        onClick: () -> Unit,
    ): LinearLayout {
        val row = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            isFocusable = true
            isFocusableInTouchMode = true
            isClickable = true
            setPadding(Theme.dp(ctx, 20), Theme.dp(ctx, 15), Theme.dp(ctx, 20), Theme.dp(ctx, 15))
            background = Theme.focusBox(
                ctx,
                normalBg = Theme.INK_900,
                focusedBg = Theme.INK_850,
                normalStroke = Theme.LINE,
                focusedStroke = if (danger) Theme.CINNABAR_400 else Theme.BAMBOO_400,
                radiusDp = 14,
            )
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                bottomMargin = Theme.dp(ctx, 10)
            }
            Theme.focusScale(this, 1.02f)
            setOnClickListener { onClick() }
        }
        row.addView(
            Theme.label(ctx, title, sp = 15f, color = Theme.PAPER_100),
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                rightMargin = Theme.dp(ctx, 16)
            }
        )
        row.addView(trailing)
        return row
    }
}
