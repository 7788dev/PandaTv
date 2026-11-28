package app.panda.tv.ui

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import app.panda.tv.model.Availability
import app.panda.tv.model.Copy
import app.panda.tv.model.Credit
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
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

class DetailScreen(ctx: Context, nav: Navigator, private val id: String, saved: android.os.Bundle? = null) : Screen(ctx, nav) {
    private var synopsisExpanded = saved?.getBoolean("expanded") ?: false
    private var restoreScrollY = saved?.getInt("scrollY")
    private var detailScroll: android.widget.ScrollView? = null

    override fun saveRoute() = super.saveRoute().apply {
        putString("page", "detail")
        putString("id", this@DetailScreen.id)
        putInt("scrollY", restoreScrollY ?: detailScroll?.scrollY ?: 0)
        putBoolean("expanded", synopsisExpanded)
    }

    override fun onRouteFocusRestored() {
        val y = restoreScrollY ?: return
        restoreScrollY = null
        detailScroll?.scrollTo(0, y)
    }

    override val showTopBar: Boolean = false

    private val m = Theme.metrics(ctx)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val container = FrameLayout(ctx).apply {
        clipChildren = true
        clipToPadding = true
        setBackgroundColor(Theme.INK_950)
    }
    private var detailItem: MediaItem? = null
    private var availability: Availability? = null
    private var relatedItems: List<MediaItem> = emptyList()
    private var loadJob: Job? = null
    private var availabilityJob: Job? = null
    private var destroyed = false
    private var playBtn: LinearLayout? = null
    private var favBtn: LinearLayout? = null
    private var metaTv: TextView? = null
    private var episodeSection: LinearLayout? = null
    private var relatedGridHolder: LinearLayout? = null
    private var peopleHolder: LinearLayout? = null
    private var castTv: TextView? = null
    private var backdropView: ImageView? = null

    override val view: View get() = container

    init {
        load()
    }

    override fun onShown() {
        detailItem?.let { refreshStateViews(it) }
    }

    override fun onDestroy() {
        destroyed = true
        loadJob?.cancel()
        availabilityJob?.cancel()
        scope.cancel()
    }

    private fun load() {
        loadJob?.cancel()
        availabilityJob?.cancel()
        container.removeAllViews()
        container.addView(Theme.loadingBox(ctx))
        loadJob = scope.launch {
            try {
                val item = nav.app.douban.subject(id)
                if (destroyed) return@launch
                detailItem = item
                render(item)
                loadAvailability(item)
                launch {
                    try {
                        val full = nav.app.douban.detail(id)
                        coroutineContext.ensureActive()
                        if (destroyed) return@launch
                        val merged = availability?.applyTo(full) ?: full
                        detailItem = merged
                        refreshStateViews(merged)
                        castTv?.apply {
                            text = merged.cast?.takeIf { it.isNotEmpty() }?.let { "${Copy.Detail.STARRING}：${it.joinToString(" / ") { person -> person.name }}" }.orEmpty()
                            visibility = if (text.isEmpty()) View.GONE else View.VISIBLE
                        }
                        backdropView?.let { nav.app.images.load(it, merged.backdrop ?: merged.poster, 1280, 720) }
                        // Keep any currently focused cast control alive until focus leaves it.
                        while (peopleHolder?.hasFocus() == true) delay(100L)
                        if (!destroyed) peopleHolder?.apply {
                            removeAllViews()
                            val people = merged.people ?: merged.cast?.map { Credit(it.name, it.role) }.orEmpty()
                            if (people.isNotEmpty()) addView(buildPeopleSection(people))
                        }
                    } catch (cancelled: CancellationException) { throw cancelled }
                    catch (_: Throwable) { if (!destroyed) nav.toast(Copy.Extra.PARTIAL_METADATA) }
                }
                launch {
                    val rel = runCatching { nav.app.douban.related(item.id) }.getOrNull() ?: emptyList()
                    coroutineContext.ensureActive()
                    if (!destroyed && rel.isNotEmpty()) {
                        relatedItems = rel
                        renderRelated()
                    }
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (t: Throwable) {
                if (!destroyed) {
                    container.removeAllViews()
                    val box = Theme.emptyOrErrorBox(ctx, Copy.errorText(t), Copy.Action.RETRY, focusRetry = true) { load() }
                    box.addView(Theme.pillButton(ctx, Copy.Action.BACK, icon = TvIcon.BACK).apply {
                        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                            gravity = Gravity.CENTER_HORIZONTAL
                            topMargin = Theme.dp(ctx, 12)
                        }
                        setOnClickListener { nav.back() }
                    })
                    container.addView(box)
                }
            }
        }
    }

    private fun loadAvailability(item: MediaItem) {
        availabilityJob?.cancel()
        if (item.type == MediaType.MOVIE) {
            episodeSection?.apply {
                removeAllViews()
                visibility = View.GONE
            }
            return
        }
        showAvailabilityLoading()
        availabilityJob = scope.launch {
            try {
                val hints = nav.app.douban.workHints(item.id)
                for (complete in listOf(false, true)) {
                    val avail = nav.app.playback.availability(item, hints, complete)
                    coroutineContext.ensureActive()
                    if (destroyed || detailItem?.id != item.id) return@launch
                    if (complete && availability == avail) continue
                    availability = avail
                    val merged = avail.applyTo(detailItem ?: item)
                    detailItem = merged
                    refreshStateViews(merged)
                    renderEpisodes(merged)
                    if (container.isShown && container.findFocus() == null) playBtn?.requestFocus()
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                if (!destroyed && detailItem?.id == item.id) renderEpisodesError(error)
            }
        }
    }

    private fun showAvailabilityLoading() {
        val sec = episodeSection ?: return
        sec.removeAllViews()
        sec.visibility = View.VISIBLE
        sec.addView(Theme.sectionHeader(ctx, Copy.Detail.EPISODES, m.pageH, Theme.dp(ctx, 8)))
        val row = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(m.pageH, Theme.dp(ctx, 8), m.pageH, Theme.dp(ctx, 8))
        }
        row.addView(ProgressBar(ctx).apply {
            indeterminateTintList = ColorStateList.valueOf(Theme.BAMBOO_400)
        }, LinearLayout.LayoutParams(Theme.dp(ctx, 24), Theme.dp(ctx, 24)).apply {
            rightMargin = Theme.dp(ctx, 10)
        })
        row.addView(Theme.label(ctx, Copy.Extra.LOADING, sp = 13.5f, color = Theme.PAPER_70))
        sec.addView(row)
    }

    private fun renderEpisodesError(error: Throwable) {
        val sec = episodeSection ?: return
        sec.removeAllViews()
        sec.visibility = View.VISIBLE
        sec.addView(Theme.sectionHeader(ctx, Copy.Detail.EPISODES, m.pageH, Theme.dp(ctx, 8)))
        val row = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(m.pageH, Theme.dp(ctx, 6), m.pageH, Theme.dp(ctx, 10))
        }
        row.addView(Theme.label(ctx, Copy.errorText(error), sp = 13.5f, color = Theme.PAPER_70, maxLines = 2), LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        val retry = Theme.pillButton(ctx, Copy.Action.RETRY, padH = 14, padV = 6).apply {
            setOnClickListener {
                playBtn?.requestFocus()
                detailItem?.let { loadAvailability(it) }
            }
        }
        row.addView(retry, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
            leftMargin = Theme.dp(ctx, 14)
        })
        sec.addView(row)
    }

    private fun render(item: MediaItem) {
        container.removeAllViews()
        val scroll = Theme.focusScrollView(ctx).apply {
            isFocusable = false
            isVerticalScrollBarEnabled = false
            clipChildren = true
            clipToPadding = false
            descendantFocusability = ViewGroup.FOCUS_AFTER_DESCENDANTS
        }
        detailScroll = scroll
        Theme.configureScrollView(ctx, scroll)
        val page = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            clipChildren = true
            clipToPadding = false
            setPadding(0, 0, 0, Theme.dp(ctx, 52))
        }

        val topBox = FrameLayout(ctx).apply {
            clipChildren = false
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        }
        val backdropFrame = FrameLayout(ctx).apply {
            clipChildren = true
        }
        val bg = FixedSizeImageView(ctx).apply {
            scaleType = ImageView.ScaleType.CENTER_CROP
            imageAlpha = 95
        }
        backdropView = bg
        nav.app.images.load(bg, item.backdrop ?: item.poster, 1280, 720)
        backdropFrame.addView(bg, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        val scrim = View(ctx).apply {
            background = GradientDrawable(
                GradientDrawable.Orientation.TOP_BOTTOM,
                intArrayOf(0x590E0D0B, 0xD40E0D0B.toInt(), Theme.INK_950),
            )
        }
        backdropFrame.addView(scrim, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        topBox.addView(backdropFrame, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, Theme.dp(ctx, 376)))

        val heroContent = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            clipChildren = false
            clipToPadding = false
            setPadding(m.pageH, m.safeV + Theme.dp(ctx, 3), m.pageH, Theme.dp(ctx, 16))
        }
        val backRow = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            clipChildren = false
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                bottomMargin = Theme.dp(ctx, 16)
            }
        }
        val backBtn = Theme.pillButton(ctx, Copy.Action.BACK, icon = TvIcon.BACK, padH = 15, padV = 7, sp = 13.5f).apply {
            setOnClickListener { nav.back() }
        }
        backRow.addView(backBtn)
        heroContent.addView(backRow)

        val split = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            clipChildren = false
        }
        val posterBox = FrameLayout(ctx).apply {
            val w = Theme.dp(ctx, 174)
            val h = Theme.dp(ctx, 261)
            layoutParams = LinearLayout.LayoutParams(w, h).apply { rightMargin = Theme.dp(ctx, 28) }
            background = Theme.box(Theme.INK_900, Theme.LINE, radiusDp = 14, ctx = ctx)
            clipToOutline = true
        }
        val posterIv = FixedSizeImageView(ctx).apply { scaleType = ImageView.ScaleType.CENTER_CROP }
        nav.app.images.load(posterIv, item.poster, 420, 630)
        posterBox.addView(posterIv, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        split.addView(posterBox)

        val infoCol = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            clipChildren = false
            clipToPadding = false
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        infoCol.addView(Theme.label(ctx, item.title, sp = 28f, color = Theme.PAPER_100, bold = true, maxLines = 2))
        item.originalTitle?.takeIf { it != item.title }?.let { orig ->
            infoCol.addView(Theme.label(ctx, orig, sp = 14f, color = Theme.PAPER_52, maxLines = 1).apply {
                layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                    topMargin = Theme.dp(ctx, 4)
                }
            })
        }

        val scoreRow = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                topMargin = Theme.dp(ctx, 12)
            }
        }
        Rules.scoreText(item)?.let { sc ->
            scoreRow.addView(Theme.label(ctx, sc, sp = 14.5f, color = Theme.AMBER_400, bold = true).apply {
                setPadding(Theme.dp(ctx, 8), Theme.dp(ctx, 2), Theme.dp(ctx, 8), Theme.dp(ctx, 2))
                background = Theme.box(0x33F4BD62, 0, radiusDp = 6, ctx = ctx)
                layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                    rightMargin = Theme.dp(ctx, 12)
                }
            })
        }
        val mTv = Theme.label(ctx, Rules.metaParts(item, region = true, genres = 3).joinToString(" · "), sp = 14f, color = Theme.PAPER_70, maxLines = 2)
        metaTv = mTv
        scoreRow.addView(mTv, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        infoCol.addView(scoreRow)

        item.directors?.takeIf { it.isNotEmpty() }?.let { dirs ->
            infoCol.addView(Theme.label(ctx, "${Copy.Detail.DIRECTOR}：${dirs.joinToString(" / ")}", sp = 13.5f, color = Theme.PAPER_70, maxLines = 1).apply {
                layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                    topMargin = Theme.dp(ctx, 12)
                }
            })
        }
        val c = item.cast.orEmpty()
        infoCol.addView(Theme.label(ctx, if (c.isEmpty()) "" else "${Copy.Detail.STARRING}：${c.joinToString(" / ") { it.name }}", sp = 13.5f, color = Theme.PAPER_70, maxLines = 1).apply {
                castTv = this
                visibility = if (c.isEmpty()) View.GONE else View.VISIBLE
                layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                    topMargin = Theme.dp(ctx, 4)
                }
            })
        item.synopsis?.let { syn ->
            val synTv = Theme.label(ctx, syn, sp = 13.5f, color = Theme.PAPER_70, maxLines = if (synopsisExpanded) 30 else 3).apply {
                setLineSpacing(Theme.dp(ctx, 4).toFloat(), 1f)
                layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                    topMargin = Theme.dp(ctx, 12)
                }
            }
            infoCol.addView(synTv)
            if (syn.length > 90) {
                val toggle = Theme.pillButton(ctx, if (synopsisExpanded) Copy.Action.COLLAPSE else Copy.Action.EXPAND, padH = 12, padV = 4, sp = 12f).apply {
                    layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                        topMargin = Theme.dp(ctx, 8)
                    }
                    setOnClickListener { v ->
                        synopsisExpanded = !synopsisExpanded
                        synTv.maxLines = if (synopsisExpanded) 30 else 3
                        ((v as LinearLayout).getChildAt(0) as? TextView)?.text = if (synopsisExpanded) Copy.Action.COLLAPSE else Copy.Action.EXPAND
                    }
                }
                infoCol.addView(toggle)
            }
        }

        val btnRow = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            clipChildren = false
            clipToPadding = false
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                topMargin = Theme.dp(ctx, 20)
            }
        }
        val pBtn = Theme.pillButton(ctx, Copy.Action.PLAY, primary = true, icon = TvIcon.PLAY, padH = 22, padV = 10, sp = 14.5f).apply {
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                rightMargin = Theme.dp(ctx, 14)
            }
            setOnClickListener {
                nav.openPlayer(item.id)
            }
        }
        pBtn.tag = "detail-play"
        playBtn = pBtn
        val fBtn = Theme.pillButton(ctx, Copy.Action.FAVORITE, icon = TvIcon.HEART, padH = 18, padV = 10, sp = 14.5f).apply {
            setOnClickListener {
                nav.saveUser(StateAction.ToggleFavorite(item.id)) { next ->
                    val added = item.id in next.favorites
                    nav.toast(if (added) Copy.Toast.FAVORITED else Copy.Toast.UNFAVORITED)
                    if (!destroyed) refreshStateViews(detailItem ?: item)
                }
            }
        }
        fBtn.tag = "detail-favorite"
        favBtn = fBtn
        btnRow.addView(pBtn)
        btnRow.addView(fBtn)
        infoCol.addView(btnRow, infoCol.indexOfChild(scoreRow) + 1)
        split.addView(infoCol)
        heroContent.addView(split)
        heroContent.addOnLayoutChangeListener { _, _, t, _, b, _, _, _, _ ->
            val h = b - t
            if (h > 0 && backdropFrame.layoutParams.height != h) {
                backdropFrame.layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, h)
            }
        }
        topBox.addView(heroContent)
        page.addView(topBox)

        val epSec = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            visibility = View.GONE
            clipChildren = true
            clipToPadding = false
            setPadding(0, Theme.dp(ctx, 24), 0, 0)
        }
        episodeSection = epSec
        page.addView(epSec)

        val people: List<Credit> = item.people ?: item.cast?.map { Credit(it.name, it.role) } ?: emptyList()
        val peopleBox = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL; clipChildren = true; clipToPadding = false }
        peopleHolder = peopleBox
        if (people.isNotEmpty()) peopleBox.addView(buildPeopleSection(people))
        page.addView(peopleBox)

        val relSec = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            visibility = View.GONE
            clipChildren = true
            clipToPadding = false
            setPadding(0, Theme.dp(ctx, 24), 0, 0)
        }
        relatedGridHolder = relSec
        page.addView(relSec)

        scroll.addView(page)
        container.addView(scroll, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        refreshStateViews(item)
        pBtn.post {
            if (pBtn.isShown && pendingFocus == null) {
                pBtn.requestFocus()
                scroll.scrollTo(0, 0)
            }
        }
    }

    private fun refreshStateViews(item: MediaItem) {
        val st = nav.app.userStore.get()
        val h = st.history.firstOrNull { it.id == item.id }
        val isFav = item.id in st.favorites
        playBtn?.let { btn ->
            val tv = btn.getChildAt(1) as? TextView ?: btn.getChildAt(0) as? TextView
            tv?.text = Rules.playLabel(item, h)
        }
        favBtn?.let { btn ->
            val tv = btn.getChildAt(1) as? TextView ?: btn.getChildAt(0) as? TextView
            tv?.text = if (isFav) Copy.Action.FAVORITED else Copy.Action.FAVORITE
            Theme.setPillSelected(btn, isFav)
        }
        metaTv?.text = Rules.metaParts(item, region = true, genres = 3).joinToString(" · ")
    }

    private fun renderEpisodes(item: MediaItem) {
        val sec = episodeSection ?: return
        val count = item.episodes ?: 0
        if (count <= 1) {
            sec.visibility = View.GONE
            return
        }
        val focusedEpisode = sec.findFocus()?.tag as? Int ?: pendingFocus?.toIntOrNull()
        val focusedRange = sec.findFocus()?.tag as? app.panda.tv.model.EpisodeRange
        sec.removeAllViews()
        sec.visibility = View.VISIBLE
        sec.addView(Theme.sectionHeader(ctx, Copy.Detail.EPISODES, m.pageH, Theme.dp(ctx, 8)))

        val currentEp = nav.app.userStore.get().history.firstOrNull { it.id == item.id }?.episode
        val ranges = Rules.episodeRanges(count, item.episodeNumbers)
        var activeRange = Rules.rangeOf(ranges, focusedEpisode ?: focusedRange?.from ?: currentEp) ?: ranges.first()

        val epGrid = Theme.horizontalGrid(ctx).apply {
            setItemSpacing(Theme.dp(ctx, 12))
        }
        val epAdapter = EpisodeAdapter(item, currentEp) { ep -> nav.openPlayer(item.id, ep) }
        epGrid.adapter = epAdapter

        if (ranges.size > 1) {
            val tabRow = Theme.horizontalGrid(ctx).apply {
                setItemSpacing(Theme.dp(ctx, 12))
            }
            tabRow.adapter = object : RecyclerView.Adapter<RecyclerView.ViewHolder>() {
                override fun getItemCount(): Int = ranges.size
                override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder {
                    val tv = TextView(ctx).apply {
                        setTextSize(TypedValue.COMPLEX_UNIT_PX, 12.5f * Theme.unit(ctx))
                        maxLines = 1
                        isFocusable = true
                        isFocusableInTouchMode = true
                        isClickable = true
                        gravity = Gravity.CENTER
                        setPadding(Theme.dp(ctx, 14), Theme.dp(ctx, 5), Theme.dp(ctx, 14), Theme.dp(ctx, 5))
                        background = Theme.focusBox(ctx, Theme.INK_900, Theme.FILL_2, Theme.LINE, Theme.BAMBOO_400, radiusDp = 999)
                        Theme.focusScale(this, 1.035f)
                    }
                    return object : RecyclerView.ViewHolder(tv) {}
                }

                override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
                    val r = ranges[position]
                    val tv = holder.itemView as TextView
                    val sel = r == activeRange
                    tv.tag = r
                    tv.text = r.label
                    tv.isSelected = sel
                    tv.setTextColor(
                        ColorStateList(
                            arrayOf(intArrayOf(android.R.attr.state_focused), intArrayOf(android.R.attr.state_selected), intArrayOf()),
                            intArrayOf(Theme.PAPER_50, Theme.BAMBOO_400, Theme.PAPER_70),
                        )
                    )
                    tv.setOnClickListener {
                        activeRange = r
                        epAdapter.setRange(r.from, r.to)
                        epGrid.scrollToPosition(0)
                        notifyDataSetChanged()
                    }
                }
            }
            if (focusedRange != null) {
                tabRow.selectedPosition = ranges.indexOf(activeRange)
                tabRow.post { if (tabRow.isShown) tabRow.requestFocus() }
            }
            sec.addView(
                Theme.framedHorizontalRow(
                    ctx,
                    tabRow,
                    rowHeightPx = Theme.dp(ctx, 44),
                    padTopPx = Theme.dp(ctx, 2),
                    padBottomPx = Theme.dp(ctx, 6),
                )
            )
        }
        epAdapter.setRange(activeRange.from, activeRange.to)
        sec.addView(
            Theme.framedHorizontalRow(
                ctx,
                epGrid,
                rowHeightPx = Theme.dp(ctx, 54),
                padTopPx = Theme.dp(ctx, 6),
                padBottomPx = Theme.dp(ctx, 6),
            )
        )
        val selected = focusedEpisode ?: currentEp
        val selectedIndex = epAdapter.numbers.indexOf(selected)
        if (selectedIndex >= 0) {
            epGrid.post {
                epGrid.selectedPosition = selectedIndex
                if (focusedEpisode != null && epGrid.isShown) epGrid.requestFocus()
            }
        }
    }

    private fun buildPeopleSection(people: List<Credit>): LinearLayout {
        val sec = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            clipChildren = true
            clipToPadding = false
            setPadding(0, Theme.dp(ctx, 24), 0, 0)
        }
        sec.addView(Theme.sectionHeader(ctx, Copy.Detail.CAST, m.pageH, Theme.dp(ctx, 6)))
        val grid = Theme.horizontalGrid(ctx).apply {
            setItemSpacing(Theme.dp(ctx, 16))
            adapter = object : RecyclerView.Adapter<RecyclerView.ViewHolder>() {
                override fun getItemCount(): Int = people.size
                override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder =
                    object : RecyclerView.ViewHolder(CastAvatarView(ctx)) {}

                override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
                    val person = people[position]
                    val card = holder.itemView as CastAvatarView
                    card.bind(person)
                    if (person.id != null) {
                        card.setOnClickListener { nav.openPerson(person.id, person.name, person.photo) }
                    } else {
                        card.setOnClickListener(null)
                    }
                }
            }
        }
        sec.addView(
            Theme.framedHorizontalRow(
                ctx,
                grid,
                rowHeightPx = Theme.dp(ctx, 168),
                padTopPx = Theme.dp(ctx, 8),
                padBottomPx = Theme.dp(ctx, 8),
            )
        )
        return sec
    }

    private fun renderRelated() {
        val sec = relatedGridHolder ?: return
        if (relatedItems.isEmpty()) return
        sec.removeAllViews()
        sec.visibility = View.VISIBLE
        sec.addView(Theme.sectionHeader(ctx, Copy.Detail.RELATED, m.pageH, Theme.dp(ctx, 6)))
        val grid = Theme.horizontalGrid(ctx).apply {
            setItemSpacing(m.gridGapH)
            adapter = object : RecyclerView.Adapter<RecyclerView.ViewHolder>() {
                override fun getItemCount(): Int = relatedItems.size
                override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder =
                    object : RecyclerView.ViewHolder(MediaCardView(ctx, wide = false)) {}

                override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
                    val item = relatedItems[position]
                    val card = holder.itemView as MediaCardView
                    card.bind(nav.app, item)
                    card.setOnClickListener { nav.openDetail(item.id) }
                }
            }
        }
        sec.addView(
            Theme.framedHorizontalRow(
                ctx,
                grid,
                rowHeightPx = m.posterRowH,
                padTopPx = m.rowPadV,
                padBottomPx = m.rowPadV,
            )
        )
    }

    private inner class CastAvatarView(context: Context) : LinearLayout(context) {
        private val avatarSize = Theme.dp(context, 70)
        private val avatarIv = FixedSizeImageView(context).apply { scaleType = ImageView.ScaleType.CENTER_CROP }
        private val initialTv = Theme.label(context, sp = 22f, color = Theme.PAPER_70, bold = true).apply { gravity = Gravity.CENTER }
        private val nameTv = Theme.label(context, sp = 13f, color = Theme.PAPER_100, bold = true, maxLines = 1).apply { gravity = Gravity.CENTER }
        private val roleTv = Theme.label(context, sp = 11.5f, color = Theme.PAPER_52, maxLines = 1).apply { gravity = Gravity.CENTER }

        init {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            isFocusable = true
            isFocusableInTouchMode = true
            isClickable = true
            setPadding(Theme.dp(context, 10), Theme.dp(context, 10), Theme.dp(context, 10), Theme.dp(context, 12))
            layoutParams = ViewGroup.MarginLayoutParams(Theme.dp(context, 110), ViewGroup.LayoutParams.WRAP_CONTENT)
            background = Theme.focusBox(context, Color.TRANSPARENT, Theme.INK_850, normalStroke = 0, radiusDp = 14)

            val circle = FrameLayout(context).apply {
                layoutParams = LayoutParams(avatarSize, avatarSize).apply { bottomMargin = Theme.dp(context, 9) }
                background = Theme.box(Theme.INK_900, Theme.LINE, radiusDp = 999, ctx = context)
            }
            circle.addView(initialTv, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            circle.addView(avatarIv, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            addView(circle)
            addView(nameTv, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
            addView(roleTv, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                topMargin = Theme.dp(context, 3)
            })
            Theme.focusScale(this, 1.035f) { hasFocus ->
                nameTv.setTextColor(if (hasFocus) Theme.PAPER_50 else Theme.PAPER_100)
                roleTv.setTextColor(if (hasFocus) Theme.PAPER_70 else Theme.PAPER_52)
            }
        }

        fun bind(p: Credit) {
            nameTv.text = p.name
            roleTv.visibility = if (!p.role.isNullOrEmpty()) View.VISIBLE else View.INVISIBLE
            roleTv.text = p.role ?: ""
            initialTv.text = Rules.avatarText(p.name)
            initialTv.visibility = View.VISIBLE
            nav.app.images.load(avatarIv, p.photo, avatarSize, avatarSize, circleTopCrop = true) { ok ->
                initialTv.visibility = if (ok) View.INVISIBLE else View.VISIBLE
            }
        }
    }

    private inner class EpisodeAdapter(
        private val item: MediaItem,
        private val currentEp: Int?,
        private val onPick: (Int) -> Unit,
    ) : RecyclerView.Adapter<RecyclerView.ViewHolder>() {
        var numbers: List<Int> = emptyList()
            private set
        private val hasTitles = !item.episodeTitles.isNullOrEmpty()

        fun setRange(f: Int, t: Int) {
            numbers = Rules.playableEpisodes(item, f, t)
            notifyDataSetChanged()
        }

        override fun getItemCount(): Int = numbers.size

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder {
            val tv = TextView(ctx).apply {
                setTextSize(TypedValue.COMPLEX_UNIT_PX, 13.5f * Theme.unit(ctx))
                gravity = Gravity.CENTER
                minWidth = Theme.dp(ctx, 54)
                maxWidth = Theme.dp(ctx, 220)
                maxLines = 1
                ellipsize = TextUtils.TruncateAt.END
                isFocusable = true
                isFocusableInTouchMode = true
                isClickable = true
                setPadding(Theme.dp(ctx, 15), Theme.dp(ctx, 8), Theme.dp(ctx, 15), Theme.dp(ctx, 8))
                background = Theme.focusBox(ctx, Theme.INK_900, Theme.FILL_2, Theme.LINE, Theme.BAMBOO_400, radiusDp = 10)
                Theme.focusScale(this, 1.035f)
            }
            return object : RecyclerView.ViewHolder(tv) {}
        }

        override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
            val ep = numbers[position]
            val tv = holder.itemView as TextView
            tv.tag = ep
            val title = item.episodeTitles?.getOrNull(ep - 1)
            tv.text = if (hasTitles && !title.isNullOrEmpty()) "$ep · $title" else "$ep"
            val active = ep == currentEp
            tv.isSelected = active
            tv.setTextColor(
                ColorStateList(
                    arrayOf(intArrayOf(android.R.attr.state_focused), intArrayOf(android.R.attr.state_selected), intArrayOf()),
                    intArrayOf(Theme.PAPER_50, Theme.BAMBOO_400, Theme.PAPER_100),
                )
            )
            tv.setOnClickListener { onPick(ep) }
        }
    }
}
