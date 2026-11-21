package app.panda.tv.ui

import android.os.Parcelable
import app.panda.tv.model.ChannelQuery
import app.panda.tv.model.MediaItem

data class ChannelPageState(
    val query: ChannelQuery,
    val items: List<MediaItem>,
    val nextCursor: String?,
    val loaded: Boolean,
    val layoutState: Parcelable?,
    val selectedPosition: Int,
    val focusPosition: Int?,
    val controlFocus: String?,
    val pageFailed: Boolean,
)
