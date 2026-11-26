package app.panda.tv.ui

import android.content.Context
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import androidx.recyclerview.widget.RecyclerView
import app.panda.tv.model.Copy
import app.panda.tv.model.MediaItem
import app.panda.tv.model.Rules
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

class PersonScreen(
    ctx: Context,
    nav: Navigator,
    private val personId: String,
    private val nameHint: String? = null,
    private val photoHint: String? = null,
) : Screen(ctx, nav) {
    override fun saveRoute() = super.saveRoute().apply {
        putString("page", "person")
        putString("id", personId)
        putString("name", nameHint)
        putString("photo", photoHint)
    }

    override val showTopBar: Boolean = false

    private val m = Theme.metrics(ctx)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val root = Theme.headerFirstColumn(ctx).apply {
        clipChildren = true
    }
    private val avatarIv = FixedSizeImageView(ctx).apply { scaleType = ImageView.ScaleType.CENTER_CROP }
    private val initialTv = Theme.label(ctx, sp = 24f, color = Theme.PAPER_70, bold = true).apply { gravity = Gravity.CENTER }
    private val nameTv = Theme.label(ctx, nameHint ?: "", sp = 24f, color = Theme.PAPER_100, bold = true, maxLines = 1)
    private lateinit var backBtn: LinearLayout
    private val bodyBox = FrameLayout(ctx).apply {
        clipChildren = true
        clipToPadding = true
    }
    private val grid = Theme.verticalGrid(ctx, bodyBox).apply {
        setHorizontalSpacing(m.gridGapH)
        setVerticalSpacing(m.gridGapV)
        setPadding(m.pageH, Theme.dp(ctx, 14), m.pageH, Theme.dp(ctx, 10))
        Theme.bindGridHeaderNavigation(this, columns = 6, onReachEnd = ::onGridEnd) { backBtn }
    }
    private val pageFooter = PosterPageFooter(ctx, grid) { loadMore(retry = true) }

    private val works = ArrayList<MediaItem>()
    private var nextCursor: String? = null
    private var loading = false
    private var destroyed = false
    private var loadJob: Job? = null
    private val adapter = WorksAdapter()

    override val view: View get() = root

    init {
        buildHeader()
        grid.adapter = adapter
        root.addView(bodyBox, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        root.addView(pageFooter)
        loadInitial()
    }

    override fun onDestroy() {
        destroyed = true
        loadJob?.cancel()
        scope.cancel()
    }

    private fun buildHeader() {
        val headerWrap = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Theme.INK_950)
            clipChildren = false
            clipToPadding = false
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        }
        val head = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            clipChildren = false
            clipToPadding = false
            setPadding(m.pageH, m.safeV, m.pageH, Theme.dp(ctx, 16))
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        }
        backBtn = Theme.pillButton(ctx, Copy.Action.BACK, icon = TvIcon.BACK, padH = 15, padV = 7, sp = 13.5f).apply {
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                rightMargin = Theme.dp(ctx, 20)
            }
            setOnClickListener { nav.back() }
        }
        head.addView(backBtn)

        val sz = Theme.dp(ctx, 68)
        val circle = FrameLayout(ctx).apply {
            layoutParams = LinearLayout.LayoutParams(sz, sz).apply { rightMargin = Theme.dp(ctx, 18) }
            background = Theme.box(Theme.INK_900, Theme.LINE, radiusDp = 999, ctx = ctx)
        }
        circle.addView(initialTv, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        circle.addView(avatarIv, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        updateAvatar(nameHint, photoHint)
        head.addView(circle)

        val titleCol = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        titleCol.addView(Theme.label(ctx, Copy.Extra.PERSON_WORKS, sp = 12f, color = Theme.BAMBOO_400, bold = true).apply {
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                bottomMargin = Theme.dp(ctx, 3)
            }
        })
        titleCol.addView(nameTv, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        head.addView(titleCol)
        headerWrap.addView(head)
        headerWrap.addView(Theme.hairline(ctx))
        root.addView(headerWrap)
    }

    private fun updateAvatar(name: String?, photo: String?) {
        val sz = Theme.dp(ctx, 68)
        initialTv.text = Rules.avatarText(name ?: "")
        initialTv.visibility = View.VISIBLE
        nav.app.images.load(avatarIv, photo, sz, sz, circleTopCrop = true) { ok ->
            initialTv.visibility = if (ok) View.INVISIBLE else View.VISIBLE
        }
    }

    private fun loadInitial() {
        loadJob?.cancel()
        works.clear()
        nextCursor = null
        bodyBox.removeAllViews()
        pageFooter.show()
        bodyBox.addView(posterPageLoading(ctx, grid))
        loadJob = scope.launch {
            try {
                loadPersonPage(nav.app.douban, personId, onInfo = { info ->
                    if (!destroyed) {
                        nameTv.text = info.name
                        updateAvatar(info.name, info.photo ?: photoHint)
                    }
                }, onWorks = { page ->
                    if (!destroyed) {
                        works.addAll(page.items)
                        nextCursor = page.next
                        bodyBox.removeAllViews()
                        if (works.isEmpty()) {
                            bodyBox.addView(Theme.emptyOrErrorBox(ctx, Copy.Extra.PERSON_NOT_FOUND))
                        } else {
                            grid.scrollToPosition(0)
                            bodyBox.addView(grid, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
                            adapter.notifyDataSetChanged()
                            Theme.reveal(grid)
                            grid.post { if (!destroyed) grid.requestFocus() }
                        }
                    }
                }, onInfoFailure = { error ->
                    android.util.Log.w("PandaTV", "[person] optional info: ${error.message}")
                })
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (t: Throwable) {
                if (!destroyed) {
                    bodyBox.removeAllViews()
                    bodyBox.addView(Theme.emptyOrErrorBox(ctx, Copy.errorText(t), Copy.Action.RETRY) { loadInitial() })
                }
            }
        }
    }

    private fun onGridEnd(position: Int, isNewPress: Boolean) {
        if (nextCursor == null) pageFooter.show(Copy.Channel.END)
        else pageFooter.onGridEnd(position, isNewPress) { loadMore() }
    }

    private fun loadMore(retry: Boolean = false) {
        val cur = nextCursor ?: return
        if (destroyed || !grid.isAttachedToWindow || loading || (pageFooter.failed && !retry)) return
        loading = true
        pageFooter.show(Copy.Channel.LOADING_MORE)
        scope.launch {
            try {
                val data = nav.app.douban
                val id = personId
                val page = awaitScreenRequest(scope) { data.personWorks(id, cur) }
                if (destroyed) return@launch
                val seen = works.map { it.id }.toHashSet()
                val added = page.items.filter { seen.add(it.id) }
                val startPos = works.size
                works.addAll(added)
                nextCursor = page.next
                pageFooter.show()
                if (added.isNotEmpty()) {
                    adapter.notifyItemRangeInserted(startPos, added.size)
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                android.util.Log.w("PandaTV", "[person] pagination: ${error.message}")
                if (!destroyed) pageFooter.show(Copy.Channel.LOAD_MORE_FAILED, retryable = true)
            } finally {
                loading = false
            }
        }
    }

    private inner class WorksAdapter : RecyclerView.Adapter<WorksAdapter.VH>() {
        init {
            setHasStableIds(true)
        }

        override fun getItemId(position: Int): Long = works[position].id.hashCode().toLong()
        override fun getItemCount(): Int = works.size
        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH = VH(MediaCardView(ctx, wide = false))
        override fun onBindViewHolder(holder: VH, position: Int) {
            if (position >= works.size - 12) grid.post {
                if (!destroyed && position >= works.size - 12) loadMore()
            }
            val item = works[position]
            holder.card.bind(nav.app, item)
            holder.card.setOnClickListener { nav.openDetail(item.id) }
        }
        inner class VH(val card: MediaCardView) : RecyclerView.ViewHolder(card)
    }
}
