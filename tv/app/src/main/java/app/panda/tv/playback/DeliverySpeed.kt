package app.panda.tv.playback

data class DeliveryScore(val picture: Double, val margin: Double? = null)
data class SourceOrderScore(val behind: Boolean, val previous: Boolean, val winner: Boolean)

object DeliverySpeed {
    const val PLAYBACK_HEADROOM = 1.25

    fun playbackMargin(seconds: Double?, length: Long?, received: Long, elapsedMs: Long, complete: Boolean): Double? {
        if (seconds == null || !seconds.isFinite() || seconds <= 0.0 || received <= 0L) return null
        val fraction = if (complete) 1.0 else if (length != null && length > 0L) minOf(1.0, received.toDouble() / length) else null
        return fraction?.let { seconds * it * 1000.0 / maxOf(1L, elapsedMs) }
    }

    private fun tier(score: DeliveryScore): Int = when {
        score.margin == null -> 1
        score.margin >= PLAYBACK_HEADROOM -> 2
        else -> 0
    }

    fun compare(a: DeliveryScore, b: DeliveryScore): Int {
        val band = tier(a).compareTo(tier(b))
        if (band != 0) return band
        val speed = (a.margin ?: 0.0).compareTo(b.margin ?: 0.0)
        val picture = a.picture.compareTo(b.picture)
        return if (tier(a) == 0) speed.takeIf { it != 0 } ?: picture else picture.takeIf { it != 0 } ?: speed
    }

    fun compareSourceOrder(a: SourceOrderScore, b: SourceOrderScore, retry: Boolean = false): Int {
        val backoff = a.behind.compareTo(b.behind)
        if (backoff != 0) return backoff
        val previous = (b.previous.compareTo(a.previous)) * if (retry) -1 else 1
        if (previous != 0) return previous
        return b.winner.compareTo(a.winner)
    }
}
