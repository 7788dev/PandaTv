package app.panda.tv.playback

import java.io.ByteArrayOutputStream
import javax.crypto.Cipher
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

data class Picture(val width: Int, val height: Int)

object PictureSize {
    private val HIGH_PROFILES = setOf(100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134)

    private class Bits(private val bytes: IntArray) {
        private var at = 0

        fun bit(): Int {
            if (at >= bytes.size * 8) throw IndexOutOfBoundsException("parameter set ends early")
            val value = (bytes[at ushr 3] ushr (7 - (at and 7))) and 1
            at++
            return value
        }

        fun read(count: Int): Int {
            var value = 0
            for (i in 0 until count) value = value * 2 + bit()
            return value
        }

        fun ue(): Int {
            var zeros = 0
            while (bit() == 0) {
                zeros++
                if (zeros > 31) throw IndexOutOfBoundsException("parameter set is not Exp-Golomb coded")
            }
            return (1 shl zeros) - 1 + (if (zeros > 0) read(zeros) else 0)
        }

        fun se(): Int {
            val value = ue()
            return if ((value and 1) != 0) (value + 1) / 2 else -(value / 2)
        }
    }

    private fun sequencePicture(nal: ByteArray, from: Int, to: Int): Picture {
        val bytes = ArrayList<Int>(to - from)
        var i = from + 1
        while (i < to) {
            if (i >= from + 3 &&
                (nal[i].toInt() and 0xff) == 3 &&
                (nal[i - 1].toInt() and 0xff) == 0 &&
                (nal[i - 2].toInt() and 0xff) == 0
            ) {
                i++
                continue
            }
            bytes.add(nal[i].toInt() and 0xff)
            i++
        }
        val bits = Bits(bytes.toIntArray())
        val profile = bits.read(8)
        bits.read(16)
        bits.ue()
        var chroma = 1
        if (profile in HIGH_PROFILES) {
            chroma = bits.ue()
            if (chroma == 3) bits.bit()
            bits.ue()
            bits.ue()
            bits.bit()
            if (bits.bit() != 0) {
                val lists = if (chroma != 3) 8 else 12
                for (list in 0 until lists) {
                    if (bits.bit() == 0) continue
                    var last = 8
                    var next = 8
                    val size = if (list < 6) 16 else 64
                    for (j in 0 until size) {
                        if (next != 0) next = (last + bits.se() + 256) % 256
                        last = if (next != 0) next else last
                    }
                }
            }
        }
        bits.ue()
        val order = bits.ue()
        if (order == 0) {
            bits.ue()
        } else if (order == 1) {
            bits.bit()
            bits.se()
            bits.se()
            val cycle = bits.ue()
            if (cycle > 255) throw IllegalArgumentException("implausible parameter set")
            for (j in 0 until cycle) bits.se()
        }
        bits.ue()
        bits.bit()
        val widthUnits = bits.ue() + 1
        val heightUnits = bits.ue() + 1
        val frames = bits.bit()
        if (frames == 0) bits.bit()
        bits.bit()
        var left = 0
        var right = 0
        var top = 0
        var bottom = 0
        if (bits.bit() != 0) {
            left = bits.ue()
            right = bits.ue()
            top = bits.ue()
            bottom = bits.ue()
        }
        val cropX = if (chroma == 0 || chroma == 3) 1 else 2
        val cropY = (if (chroma == 1) 2 else 1) * (2 - frames)
        return Picture(
            width = widthUnits * 16 - (left + right) * cropX,
            height = (2 - frames) * heightUnits * 16 - (top + bottom) * cropY,
        )
    }

    fun pictureOf(head: ByteArray): Picture? {
        try {
            var start = 0
            while (start + 188 < head.size &&
                !((head[start].toInt() and 0xff) == 0x47 && (head[start + 188].toInt() and 0xff) == 0x47)
            ) {
                start++
            }
            val streams = LinkedHashMap<Int, ByteArrayOutputStream>()
            var at = start
            while (at + 188 <= head.size) {
                if ((head[at].toInt() and 0xff) != 0x47) {
                    at += 188
                    continue
                }
                val b1 = head[at + 1].toInt() and 0xff
                val b2 = head[at + 2].toInt() and 0xff
                val b3 = head[at + 3].toInt() and 0xff
                val pid = ((b1 and 0x1f) shl 8) or b2
                val adaptation = (b3 ushr 4) and 3
                var from = at + 4
                if ((adaptation and 2) != 0) from += 1 + (head[at + 4].toInt() and 0xff)
                if ((adaptation and 1) == 0 || from >= at + 188) {
                    at += 188
                    continue
                }
                val out = streams.getOrPut(pid) { ByteArrayOutputStream(1024) }
                out.write(head, from, at + 188 - from)
                at += 188
            }
            for (out in streams.values) {
                val data = out.toByteArray()
                if (data.size < 4 ||
                    data[0].toInt() != 0 || data[1].toInt() != 0 || data[2].toInt() != 1 ||
                    (data[3].toInt() and 0xf0) != 0xe0
                ) {
                    continue
                }
                var i = 0
                while (i + 4 < data.size) {
                    if (data[i].toInt() == 0 && data[i + 1].toInt() == 0 && data[i + 2].toInt() == 1 &&
                        (data[i + 3].toInt() and 0x9f) == 7
                    ) {
                        var next = -1
                        var j = i + 4
                        while (j + 2 < data.size) {
                            if (data[j].toInt() == 0 && data[j + 1].toInt() == 0 && data[j + 2].toInt() == 1) {
                                next = j
                                break
                            }
                            j++
                        }
                        val end = if (next < 0) minOf(data.size, i + 3 + 256) else next
                        try {
                            val pic = sequencePicture(data, i + 3, end)
                            if (pic.width in 64..16384 && pic.height in 64..16384) return pic
                        } catch (_: Exception) {
                        }
                    }
                    i++
                }
            }
        } catch (_: Exception) {
        }
        return null
    }

    fun clearHead(head: ByteArray, key: ByteArray, iv: ByteArray): ByteArray {
        val whole = head.size - (head.size % 16)
        if (key.size != 16 || iv.size != 16 || whole <= 0) return ByteArray(0)
        val cipher = Cipher.getInstance("AES/CBC/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), IvParameterSpec(iv))
        return cipher.doFinal(head, 0, whole)
    }
}
