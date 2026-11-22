package app.panda.tv.ui

import org.junit.Assert.assertEquals
import org.junit.Test

class PlaybackBufferPolicyTest {
    @Test
    fun `a 1_5 GB television keeps the small buffer even with a large heap`() {
        val config = PlaybackBufferPolicy.forDevice(
            maxMemoryMb = 256,
            memoryClassMb = 256,
            totalMemoryMb = 1_536,
            lowRamDevice = false,
        )
        assertEquals(10_000, config.minBufferMs)
        assertEquals(30_000, config.maxBufferMs)
        assertEquals(16 * 1024 * 1024, config.targetBytes)
    }

    @Test
    fun `a 2 GB television stays on the small buffer at the boundary`() {
        val config = PlaybackBufferPolicy.forDevice(256, 256, 2_048, false)
        assertEquals(10_000, config.minBufferMs)
        assertEquals(30_000, config.maxBufferMs)
    }

    @Test
    fun `a device flagged low ram by the system uses the small buffer`() {
        val config = PlaybackBufferPolicy.forDevice(512, 256, 8_192, true)
        assertEquals(10_000, config.minBufferMs)
        assertEquals(16 * 1024 * 1024, config.targetBytes)
    }

    @Test
    fun `a 4 GB television with a normal heap keeps the larger buffer`() {
        val config = PlaybackBufferPolicy.forDevice(
            maxMemoryMb = 256,
            memoryClassMb = 256,
            totalMemoryMb = 4_096,
            lowRamDevice = false,
        )
        assertEquals(12_000, config.minBufferMs)
        assertEquals(48_000, config.maxBufferMs)
        assertEquals(32 * 1024 * 1024, config.targetBytes)
    }

    @Test
    fun `a small heap alone is enough to choose the small buffer`() {
        val config = PlaybackBufferPolicy.forDevice(128, 128, 4_096, false)
        assertEquals(10_000, config.minBufferMs)
        assertEquals(30_000, config.maxBufferMs)
    }
}