package app.panda.tv.state

import app.panda.tv.model.StateAction
import app.panda.tv.model.UserState
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.IOException

/** One application-owned queue. Actions read the latest committed snapshot on the IO worker. */
class UserStateWriter(
    private val store: UserStore,
    private val scope: CoroutineScope,
    private val io: CoroutineDispatcher = Dispatchers.IO,
    private val callbacks: CoroutineDispatcher = Dispatchers.Main.immediate,
    private val onCommitted: (StateAction, UserState) -> Unit = { _, _ -> },
) {
    private data class Write(val operation: () -> UserState, val callback: (Result<UserState>) -> Unit)
    private val queue = Channel<Write>(64)

    init {
        scope.launch(io) {
            for (write in queue) {
                val result = runCatching(write.operation)
                withContext(callbacks) { write.callback(result) }
            }
        }
    }

    fun dispatch(action: (UserState) -> StateAction, callback: (Result<UserState>) -> Unit) {
        var committed: StateAction? = null
        submit({
            val change = action(store.get())
            store.dispatch(change).also { committed = change }
        }) { result ->
            result.getOrNull()?.let { next -> committed?.let { onCommitted(it, next) } }
            callback(result)
        }
    }

    fun recover(restoreBackup: Boolean, callback: (Result<UserState>) -> Unit) =
        submit({ store.recover(restoreBackup) }, callback)

    private fun submit(operation: () -> UserState, callback: (Result<UserState>) -> Unit) {
        if (!queue.trySend(Write(operation, callback)).isSuccess) {
            scope.launch(callbacks) { callback(Result.failure(IOException("State write queue is full"))) }
        }
    }
}
