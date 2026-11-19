package app.panda.tv.model

import java.io.ByteArrayOutputStream

class JsonParseException(message: String) : IllegalArgumentException(message)

/**
 * Self-contained RFC 8259 JSON parser/serializer and Base64Url codec so JVM tests and Android API 22
 * share exact behavior without reflection or org.json quirks.
 */
object Json {
    fun parse(text: String): Any? {
        val clean = if (text.isNotEmpty() && text[0] == '\uFEFF') text.substring(1) else text
        val p = Parser(clean)
        val v = p.readValue(0)
        p.skipWs()
        if (!p.eof()) throw JsonParseException("Unexpected trailing character at ${p.pos}")
        return v
    }

    fun parseObject(text: String): Map<String, Any?> {
        val v = parse(text)
        @Suppress("UNCHECKED_CAST")
        return v as? Map<String, Any?> ?: throw JsonParseException("Expected JSON object")
    }

    @Suppress("UNCHECKED_CAST")
    fun row(value: Any?): Map<String, Any?> = value as? Map<String, Any?> ?: emptyMap()

    fun list(value: Any?): List<Any?> = value as? List<Any?> ?: emptyList()

    fun text(value: Any?): String? = (value as? String)?.trim()?.takeIf { it.isNotEmpty() }

    fun positive(value: Any?): Double? {
        val n = when (value) {
            is Number -> value.toDouble()
            is String -> value.trim().takeIf { it.isNotEmpty() }?.toDoubleOrNull() ?: Double.NaN
            else -> Double.NaN
        }
        return if (n.isFinite() && n > 0.0) n else null
    }

    fun positiveInt(value: Any?): Int? {
        val n = positive(value) ?: return null
        val i = n.toInt()
        return if (n == i.toDouble()) i else null
    }

    fun stringify(value: Any?): String {
        val sb = StringBuilder(256)
        writeValue(sb, value)
        return sb.toString()
    }

    private fun writeValue(sb: StringBuilder, value: Any?) {
        when (value) {
            null -> sb.append("null")
            is Boolean -> sb.append(if (value) "true" else "false")
            is Int, is Long -> sb.append(value.toString())
            is Number -> {
                val d = value.toDouble()
                if (!d.isFinite()) sb.append("null")
                else if (d == d.toLong().toDouble() && d >= -9e15 && d <= 9e15) sb.append(d.toLong().toString())
                else sb.append(d.toString())
            }
            is String -> writeString(sb, value)
            is Map<*, *> -> {
                sb.append('{')
                var first = true
                for ((k, v) in value) {
                    if (k == null) continue
                    if (!first) sb.append(',')
                    first = false
                    writeString(sb, k.toString())
                    sb.append(':')
                    writeValue(sb, v)
                }
                sb.append('}')
            }
            is Iterable<*> -> {
                sb.append('[')
                var first = true
                for (el in value) {
                    if (!first) sb.append(',')
                    first = false
                    writeValue(sb, el)
                }
                sb.append(']')
            }
            else -> writeString(sb, value.toString())
        }
    }

    private fun writeString(sb: StringBuilder, s: String) {
        sb.append('"')
        for (i in 0 until s.length) {
            when (val ch = s[i]) {
                '"' -> sb.append("\\\"")
                '\\' -> sb.append("\\\\")
                '\b' -> sb.append("\\b")
                '\u000C' -> sb.append("\\f")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                '\t' -> sb.append("\\t")
                else -> if (ch.code < 0x20) {
                    sb.append("\\u00")
                    val hex = ch.code.toString(16)
                    if (hex.length == 1) sb.append('0')
                    sb.append(hex)
                } else {
                    sb.append(ch)
                }
            }
        }
        sb.append('"')
    }

    private class Parser(private val s: String) {
        var pos = 0

        fun eof(): Boolean = pos >= s.length

        fun skipWs() {
            while (pos < s.length) {
                when (s[pos]) {
                    ' ', '\t', '\r', '\n' -> pos++
                    else -> return
                }
            }
        }

        fun readValue(depth: Int): Any? {
            if (depth > 64) throw JsonParseException("JSON nesting too deep")
            skipWs()
            if (eof()) throw JsonParseException("Unexpected end of JSON")
            return when (val ch = s[pos]) {
                '{' -> readObject(depth + 1)
                '[' -> readArray(depth + 1)
                '"' -> readString()
                't' -> expectLiteral("true", true)
                'f' -> expectLiteral("false", false)
                'n' -> expectLiteral("null", null)
                '-', in '0'..'9' -> readNumber()
                else -> throw JsonParseException("Unexpected char '$ch' at $pos")
            }
        }

        private fun expectLiteral(lit: String, value: Any?): Any? {
            if (!s.regionMatches(pos, lit, 0, lit.length)) {
                throw JsonParseException("Invalid literal at $pos")
            }
            pos += lit.length
            return value
        }

        private fun readObject(depth: Int): Map<String, Any?> {
            pos++ // '{'
            val map = LinkedHashMap<String, Any?>()
            skipWs()
            if (pos < s.length && s[pos] == '}') {
                pos++
                return map
            }
            while (true) {
                skipWs()
                if (eof() || s[pos] != '"') throw JsonParseException("Expected string key at $pos")
                val key = readString()
                skipWs()
                if (eof() || s[pos] != ':') throw JsonParseException("Expected ':' at $pos")
                pos++
                val value = readValue(depth)
                map[key] = value
                skipWs()
                if (eof()) throw JsonParseException("Unterminated object at $pos")
                when (s[pos]) {
                    ',' -> pos++
                    '}' -> {
                        pos++
                        return map
                    }
                    else -> throw JsonParseException("Expected ',' or '}' at $pos")
                }
            }
        }

        private fun readArray(depth: Int): List<Any?> {
            pos++ // '['
            val items = ArrayList<Any?>()
            skipWs()
            if (pos < s.length && s[pos] == ']') {
                pos++
                return items
            }
            while (true) {
                items.add(readValue(depth))
                skipWs()
                if (eof()) throw JsonParseException("Unterminated array at $pos")
                when (s[pos]) {
                    ',' -> pos++
                    ']' -> {
                        pos++
                        return items
                    }
                    else -> throw JsonParseException("Expected ',' or ']' at $pos")
                }
            }
        }

        private fun readString(): String {
            pos++ // '"'
            val sb = StringBuilder()
            while (pos < s.length) {
                val ch = s[pos++]
                when {
                    ch == '"' -> return sb.toString()
                    ch == '\\' -> {
                        if (eof()) throw JsonParseException("Unterminated escape")
                        when (val esc = s[pos++]) {
                            '"' -> sb.append('"')
                            '\\' -> sb.append('\\')
                            '/' -> sb.append('/')
                            'b' -> sb.append('\b')
                            'f' -> sb.append('\u000C')
                            'n' -> sb.append('\n')
                            'r' -> sb.append('\r')
                            't' -> sb.append('\t')
                            'u' -> {
                                if (pos + 4 > s.length) throw JsonParseException("Invalid unicode escape")
                                val hex = s.substring(pos, pos + 4)
                                pos += 4
                                val code = hex.toIntOrNull(16) ?: throw JsonParseException("Bad hex $hex")
                                sb.append(code.toChar())
                            }
                            else -> throw JsonParseException("Invalid escape \\$esc")
                        }
                    }
                    ch.code < 0x20 -> throw JsonParseException("Unescaped control char")
                    else -> sb.append(ch)
                }
            }
            throw JsonParseException("Unterminated string")
        }

        private fun readNumber(): Number {
            val start = pos
            if (s[pos] == '-') pos++
            if (eof()) throw JsonParseException("Invalid number")
            if (s[pos] == '0') {
                pos++
            } else if (s[pos] in '1'..'9') {
                while (pos < s.length && s[pos] in '0'..'9') pos++
            } else {
                throw JsonParseException("Invalid number at $pos")
            }
            var isFloat = false
            if (pos < s.length && s[pos] == '.') {
                isFloat = true
                pos++
                if (eof() || s[pos] !in '0'..'9') throw JsonParseException("Invalid fraction at $pos")
                while (pos < s.length && s[pos] in '0'..'9') pos++
            }
            if (pos < s.length && (s[pos] == 'e' || s[pos] == 'E')) {
                isFloat = true
                pos++
                if (pos < s.length && (s[pos] == '+' || s[pos] == '-')) pos++
                if (eof() || s[pos] !in '0'..'9') throw JsonParseException("Invalid exponent at $pos")
                while (pos < s.length && s[pos] in '0'..'9') pos++
            }
            val raw = s.substring(start, pos)
            return if (!isFloat) {
                raw.toLongOrNull() ?: raw.toDoubleOrNull() ?: throw JsonParseException("Bad int $raw")
            } else {
                raw.toDoubleOrNull() ?: throw JsonParseException("Bad float $raw")
            }
        }
    }
}

object Base64Codec {
    private const val URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    private val DECODE = IntArray(256) { -1 }.apply {
        for (i in URL_ALPHABET.indices) this[URL_ALPHABET[i].code] = i
        this['+'.code] = 62
        this['/'.code] = 63
    }

    fun encodeUrl(data: ByteArray): String {
        val sb = StringBuilder((data.size * 4 + 2) / 3)
        var i = 0
        while (i < data.size) {
            val b0 = data[i].toInt() and 0xff
            val b1 = if (i + 1 < data.size) data[i + 1].toInt() and 0xff else -1
            val b2 = if (i + 2 < data.size) data[i + 2].toInt() and 0xff else -1
            sb.append(URL_ALPHABET[b0 ushr 2])
            sb.append(URL_ALPHABET[((b0 and 0x03) shl 4) or (if (b1 >= 0) b1 ushr 4 else 0)])
            if (b1 >= 0) sb.append(URL_ALPHABET[((b1 and 0x0f) shl 2) or (if (b2 >= 0) b2 ushr 6 else 0)])
            if (b2 >= 0) sb.append(URL_ALPHABET[b2 and 0x3f])
            i += 3
        }
        return sb.toString()
    }

    fun decode(input: String): ByteArray {
        val out = ByteArrayOutputStream(input.length)
        var buf = 0
        var bits = 0
        for (i in 0 until input.length) {
            val ch = input[i]
            if (ch == '=' || ch == '\r' || ch == '\n' || ch == ' ') continue
            val code = if (ch.code < 256) DECODE[ch.code] else -1
            if (code < 0) throw IllegalArgumentException("Invalid base64 char '$ch'")
            buf = (buf shl 6) or code
            bits += 6
            if (bits >= 8) {
                bits -= 8
                out.write((buf ushr bits) and 0xff)
            }
        }
        return out.toByteArray()
    }
}
