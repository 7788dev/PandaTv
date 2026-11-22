package app.panda.tv.ui

internal data class PlaybackBufferConfig(
    val minBufferMs: Int,
    val maxBufferMs: Int,
    val targetBytes: Int,
)

internal object PlaybackBufferPolicy {
    fun forDevice(
        maxMemoryMb: Long,
        memoryClassMb: Int,
        totalMemoryMb: Long,
        lowRamDevice: Boolean,
    ): PlaybackBufferConfig {
        val low = lowRamDevice || totalMemoryMb <= 2_048L || maxMemoryMb <= 192L || memoryClassMb <= 192
        return if (low) {
            PlaybackBufferConfig(minBufferMs = 10_000, maxBufferMs = 30_000, targetBytes = 16 * 1024 * 1024)
        } else {
            PlaybackBufferConfig(minBufferMs = 12_000, maxBufferMs = 48_000, targetBytes = 32 * 1024 * 1024)
        }
    }
}