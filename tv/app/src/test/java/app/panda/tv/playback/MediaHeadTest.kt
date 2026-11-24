package app.panda.tv.playback

import app.panda.tv.model.Json
import org.junit.Assert.*
import org.junit.Test

class MediaHeadTest {
    @Test fun `MP4 signature cases agree with the current desktop implementation`() {
        val input = requireNotNull(javaClass.classLoader?.getResourceAsStream("golden-vectors.json")).use { Json.parseObject(it.bufferedReader().readText()) }
        val rows = Json.list(input["mp4Heads"]).map(Json::row)
        assertTrue("MP4 vectors must actually be present", rows.size >= 10)
        for (row in rows) {
            val hex = row["hex"] as String
            val bytes = ByteArray(hex.length / 2) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
            assertEquals(hex, row["valid"], MediaHead.isMp4Head(bytes))
        }
    }
}
