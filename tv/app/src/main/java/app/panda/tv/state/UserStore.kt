package app.panda.tv.state

import app.panda.tv.model.Constants
import app.panda.tv.model.HistoryEntry
import app.panda.tv.model.Json
import app.panda.tv.model.Quality
import app.panda.tv.model.Settings
import app.panda.tv.model.StateAction
import app.panda.tv.model.UserState
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.util.UUID

data class StateRecovery(val needed: Boolean, val canRestore: Boolean)

class UserStore(private val file: File) {
    private val lock = Any()
    private val listeners = ArrayList<(UserState) -> Unit>()
    private var state: UserState = initialUserState()
    private var loadError: Exception? = null
    private val backup = File(file.parentFile, "${file.name}.bak")

    init {
        if (file.exists()) {
            try { state = parse(file.readText(Charsets.UTF_8)) }
            catch (error: Exception) { loadError = error }
        }
    }

    fun get(): UserState = synchronized(lock) { requireHealthy(); state }

    fun recovery(): StateRecovery = synchronized(lock) {
        if (loadError == null) StateRecovery(false, false) else StateRecovery(true, backupState() != null)
    }

    fun recover(restoreBackup: Boolean): UserState = synchronized(lock) {
        if (loadError == null) throw IllegalStateException("INVALID_INPUT")
        val next = if (restoreBackup) backupState() ?: throw IOException("STATE_CORRUPT") else initialUserState()
        // Recovery is explicit. Keep the original bytes before replacing the active file.
        if (file.exists()) writeAtomic(File(file.parentFile, "${file.name}.corrupt-${UUID.randomUUID()}"), file.readBytes())
        if (backup.exists()) writeAtomic(File(file.parentFile, "${backup.name}.recovery-${UUID.randomUUID()}"), backup.readBytes())
        writeAtomic(file, serialize(next).toByteArray(Charsets.UTF_8))
        state = next
        loadError = null
        next
    }

    private fun requireHealthy() {
        loadError?.let { throw IllegalStateException("STATE_CORRUPT", it) }
    }

    private fun backupState(): UserState? = try { parse(backup.readText(Charsets.UTF_8)) } catch (_: Exception) { null }

    fun subscribe(listener: (UserState) -> Unit): () -> Unit {
        synchronized(lock) { listeners.add(listener) }
        return { synchronized(lock) { listeners.remove(listener) } }
    }

    fun dispatch(action: StateAction): UserState {
        val snapshot: UserState
        val targets: List<(UserState) -> Unit>
        synchronized(lock) {
            requireHealthy()
            val next = reduce(state, action)
            saveAtomic(next, if (file.exists()) state else next)
            state = next
            snapshot = next
            targets = listeners.toList()
        }
        for (listener in targets) listener(snapshot)
        return snapshot
    }

    private fun parse(text: String): UserState {
            val root = Json.parseObject(text)
            require(root["favorites"] is List<*> && root["history"] is List<*> && root["searches"] is List<*> && root["settings"] is Map<*, *>) { "STATE_CORRUPT" }
            val favs = Json.list(root["favorites"]).mapNotNull { it as? String }.filter { VALID_ID.matches(it) }.distinct().take(10000)
            val hist = Json.list(root["history"]).mapNotNull { parseHistory(it) }.take(10000)
            val searches = Json.list(root["searches"]).mapNotNull { it as? String }.filter { it.length <= 200 }.take(Constants.RECENT_SEARCH_MAX)
            val settings = parseSettings(Json.row(root["settings"]))
            return UserState(favs, hist, searches, settings)
    }

    private fun saveAtomic(next: UserState, previous: UserState) {
        // Back up a known valid snapshot before committing the active file.
        writeAtomic(backup, serialize(previous).toByteArray(Charsets.UTF_8))
        writeAtomic(file, serialize(next).toByteArray(Charsets.UTF_8))
    }

    private fun writeAtomic(target: File, bytes: ByteArray) {
        val parent = target.parentFile ?: throw IOException("Missing state directory")
        if (!parent.isDirectory && !parent.mkdirs()) throw IOException("Cannot create state directory")
        val tmp = File(parent, "${target.name}.${UUID.randomUUID()}.tmp")
        val rollback = File(parent, "${target.name}.${UUID.randomUUID()}.rollback")
        try {
            FileOutputStream(tmp).use { output -> output.write(bytes); output.fd.sync() }
            if (tmp.renameTo(target)) return
            // Windows cannot rename over an existing file. Never fall back to truncating it.
            if (!target.isFile || !target.renameTo(rollback)) throw IOException("Cannot replace state file")
            if (!tmp.renameTo(target)) {
                if (!rollback.renameTo(target)) throw IOException("Cannot restore state file")
                throw IOException("Cannot commit state file")
            }
        } finally {
            tmp.delete()
            if (target.isFile) rollback.delete()
        }
    }

    companion object {
        private val VALID_ID = Regex("^db-\\d{1,16}$")

        fun initialUserState(): UserState =
            UserState(emptyList(), emptyList(), emptyList(), Constants.DEFAULT_SETTINGS)

        fun reduce(state: UserState, action: StateAction): UserState = when (action) {
            is StateAction.ToggleFavorite -> {
                requireValidId(action.id)
                val next = if (action.id in state.favorites) state.favorites.filter { it != action.id }
                else (listOf(action.id) + state.favorites).take(10000)
                state.copy(favorites = next)
            }
            is StateAction.RecordHistory -> {
                val e = validateHistory(action.entry)
                val next = (listOf(e) + state.history.filter { it.id != e.id })
                    .sortedByDescending { it.at }
                    .take(10000)
                state.copy(history = next)
            }
            is StateAction.RemoveHistory -> {
                requireValidId(action.id)
                state.copy(history = state.history.filter { it.id != action.id })
            }
            StateAction.ClearHistory -> state.copy(history = emptyList())
            is StateAction.AddSearch -> {
                require(action.query.length <= 200) { "INVALID_INPUT" }
                val q = action.query.trim()
                if (q.isEmpty()) state
                else state.copy(searches = (listOf(q) + state.searches.filter { it != q }).take(Constants.RECENT_SEARCH_MAX))
            }
            StateAction.ClearSearches -> state.copy(searches = emptyList())
            is StateAction.UpdateSettings -> {
                val cur = state.settings
                val speed = action.speed?.also { require(it in Constants.SPEEDS) { "INVALID_INPUT" } } ?: cur.speed
                val vol = action.volume?.also { require(it.isFinite() && it in 0.0..1.0) { "INVALID_INPUT" } } ?: cur.volume
                state.copy(
                    settings = cur.copy(
                        autoNext = action.autoNext ?: cur.autoNext,
                        skipIntro = action.skipIntro ?: cur.skipIntro,
                        quality = action.quality ?: cur.quality,
                        speed = speed,
                        volume = vol,
                        muted = action.muted ?: cur.muted,
                    )
                )
            }
        }

        private fun requireValidId(id: String) {
            require(VALID_ID.matches(id)) { "INVALID_INPUT" }
        }

        private fun validateHistory(e: HistoryEntry): HistoryEntry {
            requireValidId(e.id)
            require(e.episode in 1..100000) { "INVALID_INPUT" }
            require(e.duration.isFinite() && e.duration in 0.0..604800.0) { "INVALID_INPUT" }
            require(e.position.isFinite() && e.position in 0.0..e.duration) { "INVALID_INPUT" }
            require(e.at >= 0L && e.at <= System.currentTimeMillis() + 60_000L) { "INVALID_INPUT" }
            return e
        }

        private fun parseHistory(raw: Any?): HistoryEntry? {
            val m = Json.row(raw)
            val id = m["id"] as? String ?: return null
            if (!VALID_ID.matches(id)) return null
            val ep = (m["episode"] as? Number)?.toInt() ?: return null
            val pos = (m["position"] as? Number)?.toDouble() ?: return null
            val dur = (m["duration"] as? Number)?.toDouble() ?: return null
            val at = (m["at"] as? Number)?.toLong() ?: return null
            return try {
                validateHistory(HistoryEntry(id, ep, pos, dur, at))
            } catch (_: Exception) {
                null
            }
        }

        private fun parseSettings(m: Map<String, Any?>): Settings {
            val d = Constants.DEFAULT_SETTINGS
            val autoNext = (m["autoNext"] as? Boolean) ?: d.autoNext
            val skipIntro = (m["skipIntro"] as? Boolean) ?: d.skipIntro
            val quality = Quality.fromWire(m["quality"] as? String) ?: d.quality
            val speed = (m["speed"] as? Number)?.toDouble()?.takeIf { it in Constants.SPEEDS } ?: d.speed
            val volume = (m["volume"] as? Number)?.toDouble()?.takeIf { it.isFinite() && it in 0.0..1.0 } ?: d.volume
            val muted = (m["muted"] as? Boolean) ?: d.muted
            return Settings(autoNext, skipIntro, quality, speed, volume, muted)
        }

        fun serialize(state: UserState): String {
            val root = linkedMapOf<String, Any?>(
                "favorites" to state.favorites,
                "history" to state.history.map {
                    linkedMapOf(
                        "id" to it.id,
                        "episode" to it.episode,
                        "position" to it.position,
                        "duration" to it.duration,
                        "at" to it.at,
                    )
                },
                "searches" to state.searches,
                "settings" to linkedMapOf(
                    "autoNext" to state.settings.autoNext,
                    "skipIntro" to state.settings.skipIntro,
                    "quality" to state.settings.quality.label,
                    "speed" to state.settings.speed,
                    "volume" to state.settings.volume,
                    "muted" to state.settings.muted,
                ),
            )
            return Json.stringify(root)
        }
    }
}
