package app.panda.tv.playback

import app.panda.tv.net.PublicResponse

/** The metadata and first-byte reads used by source admission; production uses PublicNetwork. */
interface MediaFetcher {
    suspend fun text(url: String): Pair<String, String>
    suspend fun open(url: String, headers: Map<String, String> = emptyMap()): PublicResponse
}
