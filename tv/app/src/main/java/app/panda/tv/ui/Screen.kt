package app.panda.tv.ui

import android.content.Context
import android.view.KeyEvent
import android.view.View
import androidx.leanback.widget.BaseGridView
import app.panda.tv.PandaTvApp
import app.panda.tv.model.MediaType

interface Navigator {
    val app: PandaTvApp
    fun openHome()
    fun openChannel(type: MediaType)
    fun openMe()
    fun openSearch()
    fun openSettings()
    fun openDetail(id: String)
    fun openPerson(id: String, nameHint: String? = null, photoHint: String? = null)
    fun openPlayer(id: String, episode: Int = 1)
    fun back()
    fun toast(text: String)
    fun confirm(title: String, confirmText: String, destructive: Boolean = false, onConfirm: () -> Unit)
    fun focusTopBar()
}

abstract class Screen(val ctx: Context, val nav: Navigator) {
    abstract val view: View
    open val showTopBar: Boolean = true
    open val activeTab: String? = null
    open val chromeFocusKey: String? get() = activeTab
    var lastFocused: View? = null
    private var contentFocus: View? = null
    private var focusGrid: BaseGridView? = null
    private var itemId: Long? = null
    private var itemPosition: Int? = null

    fun hasContentFocusMemory(): Boolean = contentFocus != null || focusGrid != null

    protected fun rememberedGridPosition(grid: BaseGridView): Int? = itemPosition.takeIf { focusGrid === grid }

    protected fun rememberedContentTarget(): View? = contentFocus

    protected fun rememberControlFocus(target: View) {
        contentFocus = target
        focusGrid = null
        itemId = null
        itemPosition = null
    }

    protected fun rememberGridFocus(grid: BaseGridView, position: Int) {
        if (position !in 0 until (grid.adapter?.itemCount ?: 0)) return
        contentFocus = null
        focusGrid = grid
        itemPosition = position
        itemId = grid.adapter?.getItemId(position)
    }

    fun rememberContentFocus(focused: View?) {
        var ancestor = focused
        var grid: BaseGridView? = null
        while (ancestor != null && ancestor !== view) {
            if (ancestor is BaseGridView && grid == null) grid = ancestor
            ancestor = ancestor.parent as? View
        }
        if (ancestor !== view || focused === view || focused === grid) return
        val holder = focused?.let { grid?.findContainingViewHolder(it) }
        contentFocus = focused
        focusGrid = grid
        itemId = holder?.itemId
        itemPosition = holder?.bindingAdapterPosition?.takeIf { it >= 0 }
    }

    fun restoreContentFocus(): Boolean {
        val target = contentFocus
        val grid = focusGrid?.takeIf { it.isAttachedToWindow && it.isShown }
        val holder = target?.let { grid?.findContainingViewHolder(it) }
        val sameItem = grid == null || (holder != null && holder.bindingAdapterPosition == itemPosition && holder.itemId == itemId)
        if (sameItem && target?.isAttachedToWindow == true && target.isShown && target.requestFocus()) return true
        val count = grid?.adapter?.itemCount ?: 0
        if (grid == null || count == 0) return false
        val index = itemId?.let { id -> grid.findViewHolderForItemId(id)?.bindingAdapterPosition }?.takeIf { it >= 0 }
            ?: itemPosition?.coerceIn(0, count - 1) ?: return false
        grid.selectedPosition = index
        return grid.requestFocus()
    }

    open fun onShown() {}
    open fun onHidden() {}
    open fun onDestroy() {}
    open fun onBackPressed(): Boolean = false
    open fun dispatchRemoteKey(event: KeyEvent): Boolean = false
}
