package app.panda.tv.state

import app.panda.tv.model.Constants
import app.panda.tv.model.HistoryEntry
import app.panda.tv.model.Json
import app.panda.tv.model.Quality
import app.panda.tv.model.Settings
import app.panda.tv.model.StateAction
import app.panda.tv.model.UserState
import java.io.File
import java.util.UUID

class UserStore(private val file: File) {
    private val lock = Any()
    private val listeners = ArrayList<(UserState) -> Unit>()
    private var state: UserState = loadOrDefault()

    fun get(): UserState = synchronized(lock) { state }

    fun subscribe(listener: (UserState) -> Unit): () -> Unit {
        synchronized(lock) { listeners.add(listener) }
        return { synchronized(lock) { listeners.remove(listener) } }
    }

    fun dispatch(action: StateAction): UserState {
        val snapshot: UserState
        val targets: List<(UserState) -> Unit>
        synchronized(lock) {
            val next = reduce(state, action)
            saveAtomic(next)
            state = next
            snapshot = next
            targets = listeners.toList()
        }
        for (listener in targets) listener(snapshot)
        return snapshot
    }

    private fun loadOrDefault(): UserState {
        if (!file.exists()) return initialUserState()
        return try {
            val root = Json.parseObject(file.readText(Charsets.UTF_8))
            val favs = Json.list(root["favorites"]).mapNotNull { it as? String }.filter { VALID_ID.matches(it) }.distinct().take(10000)
            val hist = Json.list(root["history"]).mapNotNull { parseHistory(it) }.take(10000)
            val searches = Json.list(root["searches"]).mapNotNull { it as? String }.filter { it.length <= 200 }.take(Constants.RECENT_SEARCH_MAX)
            val settings = parseSettings(Json.row(root["settings"]))
            UserState(favs, hist, searches, settings)
        } catch (_: Exception) {
            initialUserState()
        }
    }

    private fun saveAtomic(next: UserState) {
        file.parentFile?.mkdirs()
        val tmp = File(file.parentFile, "${file.name}.${UUID.randomUUID()}.tmp")
        tmp.writeText(serialize(next), Charsets.UTF_8)
        if (!tmp.renameTo(file)) {
            file.writeText(tmp.readText(Charsets.UTF_8), Charsets.UTF_8)
            tmp.delete()
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
