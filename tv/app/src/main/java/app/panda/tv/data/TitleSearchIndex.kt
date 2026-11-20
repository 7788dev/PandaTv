package app.panda.tv.data

import app.panda.tv.model.Json
import java.text.Normalizer
import java.util.Locale

/** The same vocabulary and per-syllable matching rules as src/shared/title-search.ts. */
class TitleSearchIndex(dictionaryJson: String, titles: String) {
    private data class Entry(val title: String, val key: String, val variants: String)
    private data class Match(val score: Double, val offset: Int, val length: Int)
    private val ranges: List<Pair<Int, String>>
    private val variants: Map<String, String>
    private val entries: List<Entry>
    val generatedAt: String

    init {
        val dictionary = Json.parseObject(dictionaryJson)
        require((dictionary["version"] as? Number)?.toInt() == 1) { "Invalid initials dictionary" }
        ranges = Json.list(dictionary["ranges"]).map { raw ->
            val range = Json.list(raw)
            Pair((range[0] as Number).toInt(), range[1] as String)
        }
        variants = Json.row(dictionary["variants"]).mapValues { it.value as String }
        val lines = titles.lineSequence().iterator()
        require(lines.hasNext() && lines.next() == "# Panda title index v1") { "Invalid title vocabulary" }
        generatedAt = if (lines.hasNext()) lines.next().removePrefix("# ") else ""
        entries = lines.asSequence().mapNotNull { line ->
            val parts = line.split('\t', limit = 3)
            if (parts.size == 3 && KEY.matches(parts[0]) && parts[2].isNotEmpty()) Entry(parts[2], parts[0], parts[1]) else null
        }.toList()
    }

    val size: Int get() = entries.size

    fun hints(input: String, limit: Int = 8): List<String> {
        return terms(input, limit)
    }

    private fun characterLetters(character: String): String {
        if (ASCII.matches(character)) return character.lowercase(Locale.ROOT)
        val code = Character.codePointAt(character, 0)
        variants[code.toString()]?.let { return it }
        for ((start, letters) in ranges) {
            val offset = code - start
            if (offset >= 0 && offset < letters.length) return letters[offset].toString()
        }
        return "?"
    }

    private fun variantExpression(query: String) = Regex(
        "(?:^|\\|)" + query.map { "[^|]*$it[^|]*" }.joinToString("\\|") + "(?=\\||$)",
    )

    private fun match(entry: Entry, query: String, expression: Regex): Match? {
        var offset = entry.key.indexOf(query)
        var alternate = false
        if (offset < 0 && entry.variants.isNotEmpty()) {
            val found = expression.find(entry.variants)
            if (found != null) {
                offset = entry.variants.take(found.range.first).count { it == '|' } + if (found.value.startsWith('|')) 1 else 0
                alternate = true
            }
        }
        if (offset < 0) return null
        val exact = offset == 0 && entry.key.length == query.length
        val base = if (exact) 0 else if (offset == 0) 10 else 40 + offset
        return Match(base + (if (alternate) 2 else 0) + (entry.key.length - query.length) / 1000.0, offset, query.length)
    }

    fun score(title: String, query: String): Double {
        val characters = titleCharacters(title)
        val plain = characters.joinToString("").lowercase(Locale.ROOT)
        val literal = titleCharacters(query).joinToString("").lowercase(Locale.ROOT)
        if (literal.isNotEmpty() && plain.contains(literal)) return if (plain == literal) -2.0 else -1.0
        val initials = initialQuery(query) ?: return Double.POSITIVE_INFINITY
        val letters = characters.map(::characterLetters)
        val key = letters.joinToString("") { it.take(1) }
        return match(Entry(title, key, letters.joinToString("|")), initials, variantExpression(initials))?.score ?: Double.POSITIVE_INFINITY
    }

    fun terms(input: String, limit: Int = 6): List<String> {
        val query = initialQuery(input) ?: return emptyList()
        val expression = variantExpression(query)
        val found = entries.mapNotNull { entry -> match(entry, query, expression)?.let { Pair(entry, it) } }
            .sortedBy { it.second.score }
        val terms = LinkedHashSet<String>()
        for ((entry, match) in found) {
            val term = titleCharacters(entry.title).drop(match.offset).take(match.length).joinToString("")
            if (term.any { it.code in 0x3400..0x9FFF || it.code in 0xF900..0xFAFF }) terms.add(term)
            if (terms.size >= limit) break
        }
        return terms.toList()
    }

    companion object {
        fun suggestedSubjectIds(value: Any?): List<String> {
            val ids = LinkedHashSet<String>()
            for (raw in Json.list(value)) {
                val item = Json.row(raw)
                val link = item["url"] as? String ?: continue
                if (item["type"] != "movie") continue
                try {
                    val url = java.net.URI(link)
                    val id = SUBJECT_PATH.matchEntire(url.path.orEmpty())?.groupValues?.get(1) ?: continue
                    if ((item["id"] == null || item["id"] == id) && url.scheme?.lowercase(Locale.ROOT) == "https" && url.host?.lowercase(Locale.ROOT) == "movie.douban.com" && url.userInfo.isNullOrEmpty()) ids.add(id)
                } catch (_: Exception) { /* Ignore invalid identity hints. */ }
                if (ids.size >= 8) break
            }
            return ids.toList()
        }

        private val SUBJECT_PATH = Regex("^/subject/(\\d{1,16})/?$")
        private val KEY = Regex("^[a-z0-9]{2,160}$")
        private val ASCII = Regex("^[a-z0-9]$", RegexOption.IGNORE_CASE)
        private val INITIALS_QUERY = Regex("^[a-z][a-z0-9]{1,31}$")
        private val INVISIBLE = Regex("[\\u200B-\\u200F\\u202A-\\u202E\\u2060\\uFEFF]")

        fun initialQuery(value: String): String? {
            val query = Normalizer.normalize(value, Normalizer.Form.NFKC).replace(Regex("\\s+"), "").lowercase(Locale.ROOT)
            return query.takeIf { INITIALS_QUERY.matches(it) }
        }

        fun titleCharacters(title: String): List<String> {
            val normalized = INVISIBLE.replace(Normalizer.normalize(title, Normalizer.Form.NFKC), "")
            val characters = ArrayList<String>()
            var at = 0
            while (at < normalized.length) {
                val code = Character.codePointAt(normalized, at)
                val size = Character.charCount(code)
                if (Character.isLetterOrDigit(code)) characters.add(normalized.substring(at, at + size))
                at += size
            }
            return characters
        }
    }
}
