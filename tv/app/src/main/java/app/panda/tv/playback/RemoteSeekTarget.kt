package app.panda.tv.playback

/** Coalesces a burst of remote seek steps against the latest requested target. */
object RemoteSeekTarget {
    fun relative(currentPositionMs: Long, pendingPositionMs: Long?, deltaMs: Long, durationMs: Long): Long? {
        if (durationMs <= 0L) return null
        val base = (pendingPositionMs ?: currentPositionMs).coerceIn(0L, durationMs)
        val target = when {
            deltaMs > 0L && base > Long.MAX_VALUE - deltaMs -> Long.MAX_VALUE
            deltaMs < 0L && base < Long.MIN_VALUE - deltaMs -> Long.MIN_VALUE
            else -> base + deltaMs
        }
        return target.coerceIn(0L, durationMs)
    }
}
