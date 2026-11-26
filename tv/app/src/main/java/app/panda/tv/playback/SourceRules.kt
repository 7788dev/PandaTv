package app.panda.tv.playback

import app.panda.tv.model.Json
import app.panda.tv.net.PublicNetwork
import java.io.File
import java.io.InputStream

data class PlaySource(
    val key: String,
    val name: String,
    val api: String,
    val enabled: Boolean,
    val priority: Int,
    val adPaths: List<String>,
    val fingerprints: List<List<Double>>,
    val excludedRecordIds: Set<String> = emptySet(),
)

data class SourceRules(
    val version: Int,
    val verifiedAt: String,
    val maxDropRatio: Double,
    val foreignBlockMaxSeconds: Double,
    val sources: List<PlaySource>,
)

object SourceRulesLoader {
    private val RECORD_ID = Regex("^[A-Za-z0-9_-]{1,64}$")
    private val KEY_REGEX = Regex("^[a-z0-9-]{1,32}$")
    private val AD_PATH_REGEX = Regex("^/(?:[A-Za-z0-9_-]+/){2,6}$")
    private val DATE_PREFIX_REGEX = Regex("^\\d{4}-\\d{2}-\\d{2}.*$")

    fun validate(rawText: String): SourceRules {
        val clean = if (rawText.isNotEmpty() && rawText[0] == '\uFEFF') rawText.substring(1) else rawText
        val data = Json.parseObject(clean)
        val version = (data["version"] as? Number)?.let { n ->
            if (n.toDouble() == n.toInt().toDouble()) n.toInt() else -1
        } ?: -1
        val verifiedAt = data["verifiedAt"] as? String ?: ""
        val maxDropRatio = (data["maxDropRatio"] as? Number)?.toDouble() ?: Double.NaN
        val foreignMax = (data["foreignBlockMaxSeconds"] as? Number)?.toDouble() ?: Double.NaN
        val rawSources = data["sources"] as? List<*>

        if (version < 1 || !DATE_PREFIX_REGEX.matches(verifiedAt) || rawSources == null ||
            !maxDropRatio.isFinite() || maxDropRatio <= 0.0 || maxDropRatio > 0.15 ||
            !foreignMax.isFinite() || foreignMax < 0.0 || foreignMax > 90.0
        ) {
            throw IllegalArgumentException("播放源规则版本或安全限制无效")
        }
        if (rawSources.size > 30) throw IllegalArgumentException("播放源数量过多")

        val keys = HashSet<String>()
        val sources = ArrayList<PlaySource>(rawSources.size)
        for (entry in rawSources) {
            val row = Json.row(entry)
            val key = row["key"] as? String ?: ""
            val name = row["name"] as? String
            val api = row["api"] as? String ?: ""
            val enabled = row["enabled"] as? Boolean
            val priorityNum = (row["priority"] as? Number)?.toDouble()
            val adPathsRaw = row["adPaths"] as? List<*>
            val fpRaw = row["fingerprints"] as? List<*>

            if (!KEY_REGEX.matches(key) || !keys.add(key) || name == null || name.length > 40 ||
                enabled == null || priorityNum == null || !priorityNum.isFinite()
            ) {
                throw IllegalArgumentException("播放源身份无效")
            }
            PublicNetwork.validatePublicUrl(api)

            if (adPathsRaw == null) throw IllegalArgumentException("广告路径规则无效")
            val adPaths = adPathsRaw.map { p ->
                val s = p as? String ?: throw IllegalArgumentException("广告路径规则无效")
                if (!AD_PATH_REGEX.matches(s)) throw IllegalArgumentException("广告路径规则无效")
                s
            }

            if (fpRaw == null) throw IllegalArgumentException("广告时长指纹无效")
            val fingerprints = fpRaw.map { fp ->
                val nums = fp as? List<*> ?: throw IllegalArgumentException("广告时长指纹无效")
                if (nums.size !in 4..16) throw IllegalArgumentException("广告时长指纹无效")
                nums.map { v ->
                    val d = (v as? Number)?.toDouble() ?: throw IllegalArgumentException("广告时长指纹无效")
                    if (!d.isFinite() || d <= 0.0 || d > 20.0) throw IllegalArgumentException("广告时长指纹无效")
                    d
                }
            }
            val excluded = if ("excludedRecordIds" in row) {
                val ids = row["excludedRecordIds"] as? List<*> ?: throw IllegalArgumentException("片源排除记录无效")
                require(ids.size <= 2048 && ids.all { it is String && it.matches(RECORD_ID) }) { "片源排除记录无效" }
                ids.filterIsInstance<String>().toSet()
            } else emptySet()
            sources.add(PlaySource(key, name, api, enabled, priorityNum.toInt(), adPaths, fingerprints, excluded))
        }
        return SourceRules(version, verifiedAt, maxDropRatio, foreignMax, sources)
    }

    fun resolve(bundledStream: InputStream, overrideFile: File?, report: (String) -> Unit = {}): SourceRules {
        val shipped = validate(bundledStream.bufferedReader(Charsets.UTF_8).readText())
        if (overrideFile == null || !overrideFile.exists()) return shipped
        return try {
            val custom = validate(overrideFile.readText(Charsets.UTF_8))
            if (custom.version < shipped.version) {
                report("rules override v${custom.version} is older than bundled v${shipped.version}; ignored")
                shipped
            } else {
                report("rules override v${custom.version} in use")
                custom
            }
        } catch (e: Exception) {
            report("rules override rejected: ${e.message}")
            shipped
        }
    }
}
