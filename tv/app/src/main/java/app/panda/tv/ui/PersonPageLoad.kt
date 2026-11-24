package app.panda.tv.ui

import app.panda.tv.data.DoubanDataSource
import app.panda.tv.model.MediaItem
import app.panda.tv.model.Page
import app.panda.tv.model.PersonInfo
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch

/** The available works render immediately; optional header information shares the page's cancellation. */
internal suspend fun loadPersonPage(
    data: DoubanDataSource,
    id: String,
    onInfo: (PersonInfo) -> Unit,
    onWorks: (Page<MediaItem>) -> Unit,
    onInfoFailure: (Throwable) -> Unit,
) = coroutineScope {
    launch {
        try { onInfo(data.person(id)) }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (error: Exception) { onInfoFailure(error) }
    }
    onWorks(data.personWorks(id, null))
}
