package app.panda.tv.state

import app.panda.tv.model.Json
import app.panda.tv.model.Quality
import app.panda.tv.playback.DurationHistory
import app.panda.tv.playback.BudgetConfig
import app.panda.tv.playback.FailureCounts
import app.panda.tv.playback.FailureKind
import app.panda.tv.playback.HealthConfig
import app.panda.tv.playback.HealthEntry
import app.panda.tv.playback.HealthRules
import app.panda.tv.playback.HealthVerdict
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.util.UUID
import kotlin.math.max
import kotlin.math.min

data class SourceHealthGlobalView(
    val sourceKey: String,
    val score: Double,
    val cooled: Boolean,
    val success: Int,
    val failure: FailureCounts,
    val playSeconds: Double,
    val stallSeconds: Double,
    val startupMedian: Double?,
    val shownQuality: Quality?,
    val lastFailureKind: FailureKind?,
)

data class SourceHealthWorkView(
    val workId: String,
    val sourceKey: String,
    val available: Boolean,
    val scoreDelta: Double,
    val lastSuccessAt: Long?,
    val lastFailureKind: FailureKind?,
)

data class SourceHealthSnapshot(
    val generatedAt: Long,
    val globals: List<SourceHealthGlobalView>,
    val works: List<SourceHealthWorkView>,
)

class SourceHealthStore(
    private val file: File,
    private val cfg: HealthConfig,
    private val budget: BudgetConfig,
    private val clock: () -> Long = { System.currentTimeMillis() },
    private val onWriteFailure: (String) -> Unit = {},
) {
    data class WorkHealthEntry(
        val workId: String,
        val sourceKey: String,
        val episodeFrom: Int,
        val episodeTo: Int,
        val available: Boolean,
        val lastSuccessAt: Long?,
        val lastFailureKind: FailureKind?,
        val scoreDelta: Double,
    )

    private data class LiveStats(var playSeconds: Double, var stallSeconds: Double)
    private data class DurationObservation(val work: String, val episode: Int, val source: String, val seconds: Double)

    private val lock = Any()
    private val globals = ArrayList<HealthEntry>()
    private val works = ArrayList<WorkHealthEntry>()
    private val live = HashMap<String, LiveStats>()
    private val durations = ArrayList<DurationObservation>()
    private var lastSaveAt = Long.MIN_VALUE

    init {
        load()
    }

    fun rankFor(sourceKey: String, workId: String, at: Long = clock()): HealthVerdict = synchronized(lock) {
        val entry = globals.firstOrNull { it.sourceKey == sourceKey }
            ?: return HealthVerdict(cooled = false, rank = 0.5)
        val verdict = HealthRules.verdictOf(withLive(entry), at, cfg)
        if (verdict.cooled) return HealthVerdict(cooled = true, rank = -1.0)
        val work = works.firstOrNull { it.workId == workId && it.sourceKey == sourceKey }
        HealthVerdict(
            cooled = false,
            rank = combineWorkDelta(verdict.rank, work?.scoreDelta ?: 0.0, cfg.workDeltaMax),
        )
    }

    fun recordSuccess(
        sourceKey: String,
        workId: String,
        episode: Int,
        at: Long = clock(),
        startupSec: Double? = null,
        quality: Quality? = null,
    ) = synchronized(lock) {
        val entry = ensureGlobal(sourceKey, at)
        val median = when {
            startupSec == null -> entry.startupMedian
            entry.startupMedian == null -> startupSec
            else -> entry.startupMedian * 0.7 + startupSec * 0.3
        }
        val draft = entry.copy(
            success = entry.success + 1,
            lastSuccessAt = at,
            cooldownUntil = null,
            startupMedian = median,
            startupWorst = if (startupSec == null) entry.startupWorst else max(entry.startupWorst ?: 0.0, startupSec),
            shownQuality = quality ?: entry.shownQuality,
            score = 0.0,
            scoredAt = at,
        )
        replaceGlobal(draft.copy(score = HealthRules.scoreOf(draft, at, cfg)))
        touchWork(workId, sourceKey, episode, available = true, at = at, kind = null, delta = WORK_STEP)
        saveThrottled()
    }

    fun recordFailure(
        sourceKey: String,
        kind: FailureKind,
        workId: String,
        episode: Int,
        at: Long = clock(),
    ) = synchronized(lock) {
        val entry = ensureGlobal(sourceKey, at)
        replaceGlobal(HealthRules.withFailure(entry, kind, at, cfg, budget.failedSourceCooldownSec))
        touchWork(workId, sourceKey, episode, available = false, at = at, kind = kind, delta = -WORK_STEP * 4)
        saveThrottled()
    }

    fun markCooldown(sourceKey: String, at: Long = clock()) = synchronized(lock) {
        val entry = ensureGlobal(sourceKey, at)
        replaceGlobal(entry.copy(cooldownUntil = at + (budget.failedSourceCooldownSec * 1000).toLong()))
        saveThrottled()
    }

    fun updateLive(sourceKey: String, playSeconds: Double = 0.0, stallSeconds: Double = 0.0) = synchronized(lock) {
        val stats = live.getOrPut(sourceKey) { LiveStats(0.0, 0.0) }
        stats.playSeconds += max(0.0, playSeconds)
        stats.stallSeconds += max(0.0, stallSeconds)
    }

    fun observeDuration(work: String, episode: Int, source: String, seconds: Double) = synchronized(lock) {
        if (!seconds.isFinite() || seconds <= 0.0) return
        if (durations.lastOrNull { it.work == work && it.episode == episode && it.source == source }?.seconds == seconds) return
        durations.add(DurationObservation(work, episode, source, seconds))
        if (durations.size > WORK_LIMIT) durations.removeAt(0)
    }

    fun durationHistory(work: String, episode: Int, from: String, to: String): DurationHistory = synchronized(lock) {
        val relevant = durations.filter { it.work == work && (it.source == from || it.source == to) }
        val samples = relevant.filter { it.episode == episode && it.source == to }.map { it.seconds }
        val ratios = relevant.filter { it.episode != episode }.groupBy { it.episode }.values.mapNotNull { rows ->
            val a = rows.lastOrNull { it.source == from }?.seconds ?: return@mapNotNull null
            val b = rows.lastOrNull { it.source == to }?.seconds ?: return@mapNotNull null
            kotlin.math.abs(b - a) / max(a, 1.0)
        }
        DurationHistory(samples, ratios)
    }

    fun snapshot(workId: String? = null): SourceHealthSnapshot = synchronized(lock) {
        val at = clock()
        val globalViews = globals.map { entry ->
            val active = withLive(entry)
            val verdict = HealthRules.verdictOf(active, at, cfg)
            SourceHealthGlobalView(
                sourceKey = entry.sourceKey,
                score = max(0.0, verdict.rank),
                cooled = verdict.cooled,
                success = entry.success,
                failure = entry.failure,
                playSeconds = active.playSeconds,
                stallSeconds = active.stallSeconds,
                startupMedian = entry.startupMedian,
                shownQuality = entry.shownQuality,
                lastFailureKind = entry.lastFailureKind,
            )
        }
        val workViews = works
            .filter { workId == null || it.workId == workId }
            .map {
                SourceHealthWorkView(
                    workId = it.workId,
                    sourceKey = it.sourceKey,
                    available = it.available,
                    scoreDelta = it.scoreDelta,
                    lastSuccessAt = it.lastSuccessAt,
                    lastFailureKind = it.lastFailureKind,
                )
            }
        SourceHealthSnapshot(at, globalViews, workViews)
    }

    fun flush() = synchronized(lock) {
        save()
        lastSaveAt = clock()
    }

    private fun ensureGlobal(sourceKey: String, at: Long): HealthEntry {
        globals.firstOrNull { it.sourceKey == sourceKey }?.let { return it }
        val entry = HealthEntry(
            sourceKey = sourceKey,
            success = 0,
            failure = FailureCounts(),
            startupMedian = null,
            startupWorst = null,
            playSeconds = 0.0,
            stallSeconds = 0.0,
            shownQuality = null,
            lastSuccessAt = null,
            lastFailureAt = null,
            lastFailureKind = null,
            score = 0.0,
            scoredAt = at,
            decayVersion = cfg.decayVersion,
            cooldownUntil = null,
            lastAlignmentDegrade = null,
        )
        globals.add(entry)
        if (globals.size > GLOBAL_LIMIT) globals.removeAt(0)
        return entry
    }

    private fun replaceGlobal(entry: HealthEntry) {
        val index = globals.indexOfFirst { it.sourceKey == entry.sourceKey }
        if (index < 0) globals.add(entry) else globals[index] = entry
    }

    private fun withLive(entry: HealthEntry): HealthEntry {
        val stats = live[entry.sourceKey] ?: return entry
        return entry.copy(
            playSeconds = entry.playSeconds + stats.playSeconds,
            stallSeconds = entry.stallSeconds + stats.stallSeconds,
        )
    }

    private fun touchWork(
        workId: String,
        sourceKey: String,
        episode: Int,
        available: Boolean,
        at: Long,
        kind: FailureKind?,
        delta: Double,
    ) {
        val index = works.indexOfFirst { it.workId == workId && it.sourceKey == sourceKey }
        val existing = if (index >= 0) works[index] else null
        val next = if (existing == null) {
            WorkHealthEntry(
                workId = workId,
                sourceKey = sourceKey,
                episodeFrom = episode,
                episodeTo = episode,
                available = available,
                lastSuccessAt = if (available) at else null,
                lastFailureKind = if (available) null else kind,
                scoreDelta = delta.coerceIn(-1.0, 1.0),
            )
        } else {
            existing.copy(
                episodeFrom = min(existing.episodeFrom, episode),
                episodeTo = max(existing.episodeTo, episode),
                available = available,
                lastSuccessAt = if (available) at else existing.lastSuccessAt,
                lastFailureKind = if (available) existing.lastFailureKind else kind,
                scoreDelta = (existing.scoreDelta + delta).coerceIn(-1.0, 1.0),
            )
        }
        if (index >= 0) works[index] = next else {
            works.add(next)
            if (works.size > WORK_LIMIT) {
                works.removeAt(works.indices.minByOrNull { works[it].lastSuccessAt ?: 0L } ?: 0)
            }
        }
    }

    private fun combineWorkDelta(score: Double, delta: Double, max: Double): Double =
        (score * (1.0 + delta.coerceIn(-max, max))).coerceIn(0.0, 1.0)

    private fun load() {
        if (!file.exists()) return
        try {
            val root = Json.parseObject(file.readText(Charsets.UTF_8))
            val version = (root["version"] as? Number)?.toInt()
            if (version != 1) throw IllegalStateException("SOURCE_HEALTH_VERSION")
            globals.addAll(Json.list(root["globals"]).mapNotNull(::parseEntry).take(GLOBAL_LIMIT))
            works.addAll(Json.list(root["works"]).mapNotNull(::parseWork).take(WORK_LIMIT))
            for (value in Json.list(root["durations"]).takeLast(WORK_LIMIT)) {
                val row = Json.row(value)
                val work = Json.text(row["workId"]) ?: continue
                val source = Json.text(row["sourceKey"]) ?: continue
                val episode = (row["episode"] as? Number)?.toInt()?.takeIf { it > 0 } ?: continue
                val seconds = positiveOrNull(row["seconds"]) ?: continue
                durations.add(DurationObservation(work, episode, source, seconds))
            }
        } catch (error: Exception) {
            val parent = file.parentFile
            if (parent != null) {
                try { file.copyTo(File(parent, "${file.name}.bak"), overwrite = true) } catch (_: Exception) { }
                if (error.message == "SOURCE_HEALTH_VERSION") {
                    try { file.copyTo(File(parent, "${file.name}.unsupported-${UUID.randomUUID()}"), overwrite = true) } catch (_: Exception) { }
                }
            }
            globals.clear()
            works.clear()
            durations.clear()
        }
    }

    private fun saveThrottled() {
        val now = clock()
        if (lastSaveAt != Long.MIN_VALUE && now - lastSaveAt < SAVE_INTERVAL_MS) return
        save()
        lastSaveAt = now
    }

    private fun save() {
        try {
            val persistedGlobals = globals.map(::withLive)
            val root = linkedMapOf<String, Any?>(
                "version" to 1,
                "writtenAt" to clock(),
                "atomicMarker" to "panda-source-health-v1",
                "decayVersion" to cfg.decayVersion,
                "globals" to persistedGlobals.map(::serializeEntry),
                "works" to works.map(::serializeWork),
                "durations" to durations.map { mapOf("workId" to it.work, "episode" to it.episode, "sourceKey" to it.source, "seconds" to it.seconds) },
            )
            writeAtomic(file, Json.stringify(root).toByteArray(Charsets.UTF_8))
            globals.clear()
            globals.addAll(persistedGlobals)
            live.clear()
        } catch (error: Exception) {
            onWriteFailure(error.message ?: "write failed")
        }
    }

    private fun serializeEntry(entry: HealthEntry): Map<String, Any?> = linkedMapOf(
        "sourceKey" to entry.sourceKey,
        "success" to entry.success,
        "failure" to linkedMapOf(
            "catalogue" to entry.failure.catalogue,
            "probe" to entry.failure.probe,
            "firstSegment" to entry.failure.firstSegment,
            "stall" to entry.failure.stall,
            "alignment" to entry.failure.alignment,
        ),
        "startupMedian" to entry.startupMedian,
        "startupWorst" to entry.startupWorst,
        "playSeconds" to entry.playSeconds,
        "stallSeconds" to entry.stallSeconds,
        "shownQuality" to entry.shownQuality?.label,
        "lastSuccessAt" to entry.lastSuccessAt,
        "lastFailureAt" to entry.lastFailureAt,
        "lastFailureKind" to entry.lastFailureKind?.wire,
        "score" to entry.score,
        "scoredAt" to entry.scoredAt,
        "decayVersion" to entry.decayVersion,
        "cooldownUntil" to entry.cooldownUntil,
        "lastAlignmentDegrade" to entry.lastAlignmentDegrade,
    )

    private fun serializeWork(work: WorkHealthEntry): Map<String, Any?> = linkedMapOf(
        "workId" to work.workId,
        "sourceKey" to work.sourceKey,
        "episodeFrom" to work.episodeFrom,
        "episodeTo" to work.episodeTo,
        "available" to work.available,
        "lastSuccessAt" to work.lastSuccessAt,
        "lastFailureKind" to work.lastFailureKind?.wire,
        "scoreDelta" to work.scoreDelta,
    )

    private fun parseEntry(value: Any?): HealthEntry? {
        val row = Json.row(value)
        val sourceKey = Json.text(row["sourceKey"]) ?: return null
        if (sourceKey.length > 80) return null
        val failure = Json.row(row["failure"])
        return HealthEntry(
            sourceKey = sourceKey,
            success = nonNegativeInt(row, "success", 0),
            failure = FailureCounts(
                catalogue = nonNegativeInt(failure, "catalogue", 0),
                probe = nonNegativeInt(failure, "probe", 0),
                firstSegment = nonNegativeInt(failure, "firstSegment", 0),
                stall = nonNegativeInt(failure, "stall", 0),
                alignment = nonNegativeInt(failure, "alignment", 0),
            ),
            startupMedian = positiveOrNull(row["startupMedian"]),
            startupWorst = positiveOrNull(row["startupWorst"]),
            playSeconds = max(0.0, (row["playSeconds"] as? Number)?.toDouble() ?: 0.0),
            stallSeconds = max(0.0, (row["stallSeconds"] as? Number)?.toDouble() ?: 0.0),
            shownQuality = Quality.fromWire(Json.text(row["shownQuality"])),
            lastSuccessAt = timeOrNull(row["lastSuccessAt"]),
            lastFailureAt = timeOrNull(row["lastFailureAt"]),
            lastFailureKind = FailureKind.fromWire(Json.text(row["lastFailureKind"])),
            score = ((row["score"] as? Number)?.toDouble() ?: 0.0).coerceIn(0.0, 1.0),
            scoredAt = timeOrNull(row["scoredAt"]) ?: clock(),
            decayVersion = Json.text(row["decayVersion"]) ?: cfg.decayVersion,
            cooldownUntil = timeOrNull(row["cooldownUntil"]),
            lastAlignmentDegrade = Json.text(row["lastAlignmentDegrade"]),
        )
    }

    private fun parseWork(value: Any?): WorkHealthEntry? {
        val row = Json.row(value)
        val workId = Json.text(row["workId"]) ?: return null
        val sourceKey = Json.text(row["sourceKey"]) ?: return null
        val from = ((row["episodeFrom"] as? Number)?.toInt() ?: 1).coerceAtLeast(1)
        val to = ((row["episodeTo"] as? Number)?.toInt() ?: from).coerceAtLeast(from)
        return WorkHealthEntry(
            workId = workId,
            sourceKey = sourceKey,
            episodeFrom = from,
            episodeTo = to,
            available = row["available"] != false,
            lastSuccessAt = timeOrNull(row["lastSuccessAt"]),
            lastFailureKind = FailureKind.fromWire(Json.text(row["lastFailureKind"])),
            scoreDelta = ((row["scoreDelta"] as? Number)?.toDouble() ?: 0.0).coerceIn(-1.0, 1.0),
        )
    }

    private fun nonNegativeInt(row: Map<String, Any?>, key: String, fallback: Int): Int {
        val value = (row[key] as? Number)?.toInt() ?: return fallback
        return max(0, value)
    }

    private fun positiveOrNull(value: Any?): Double? =
        (value as? Number)?.toDouble()?.takeIf { it.isFinite() && it > 0.0 }

    private fun timeOrNull(value: Any?): Long? =
        (value as? Number)?.toLong()?.takeIf { it > 0L }

    private fun writeAtomic(target: File, bytes: ByteArray) {
        val parent = target.parentFile ?: throw IOException("Missing health directory")
        if (!parent.isDirectory && !parent.mkdirs()) throw IOException("Cannot create health directory")
        val tmp = File(parent, "${target.name}.${UUID.randomUUID()}.tmp")
        val rollback = File(parent, "${target.name}.${UUID.randomUUID()}.rollback")
        try {
            FileOutputStream(tmp).use { output -> output.write(bytes); output.fd.sync() }
            if (tmp.renameTo(target)) return
            if (!target.isFile || !target.renameTo(rollback)) throw IOException("Cannot replace health file")
            if (!tmp.renameTo(target)) {
                if (!rollback.renameTo(target)) throw IOException("Cannot restore health file")
                throw IOException("Cannot commit health file")
            }
        } finally {
            tmp.delete()
            if (target.isFile) rollback.delete()
        }
    }

    companion object {
        private const val GLOBAL_LIMIT = 128
        private const val WORK_LIMIT = 2400
        private const val WORK_STEP = 0.05
        private const val SAVE_INTERVAL_MS = 5 * 60 * 1000L
    }
}
