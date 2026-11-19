package app.panda.tv.ui

import android.content.Context
import android.view.KeyEvent
import android.view.View
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
    var lastFocused: View? = null

    open fun onShown() {}
    open fun onHidden() {}
    open fun onDestroy() {}
    open fun onBackPressed(): Boolean = false
    open fun dispatchRemoteKey(event: KeyEvent): Boolean = false
}
