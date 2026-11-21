package app.panda.tv

import app.panda.tv.data.DoubanDataSource
import app.panda.tv.data.DataError
import app.panda.tv.data.DataErrorCode
import app.panda.tv.data.HttpReply
import app.panda.tv.data.MetadataFetcher
import app.panda.tv.data.TitleSearchIndex
import app.panda.tv.model.Json
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.net.URI
import java.net.URLDecoder

class TitleSearchTest {
    private fun asset(name: String): String = listOf(File("src/main/assets/$name"), File("app/src/main/assets/$name"))
        .first { it.exists() }.readText(Charsets.UTF_8)

    private val index by lazy { TitleSearchIndex(asset("search-initials.json"), asset("search-titles.tsv")) }

    @Test
    fun `initial matching and query vocabulary match desktop golden cases`() {
        val stream = requireNotNull(javaClass.classLoader?.getResourceAsStream("golden-vectors.json"))
        val vectors = Json.parseObject(stream.bufferedReader(Charsets.UTF_8).use { it.readText() })
        val cases = Json.row(vectors["titleSearch"])
        for (raw in Json.list(cases["suggestions"])) {
            val test = Json.row(raw)
            assertEquals(Json.list(test["ids"]), TitleSearchIndex.suggestedSubjectIds(test["input"]))
        }
        assertTrue("A fresh install needs a complete title index", index.size > 20_000)
        assertEquals("蜡笔小新", index.hints("LBXX").first())
        for (raw in Json.list(cases["queries"])) {
            val test = Json.row(raw)
            val query = test["query"] as String
            assertEquals(query, test["initial"], TitleSearchIndex.initialQuery(query))
            assertEquals(query, Json.list(test["terms"]), index.terms(query))
        }
        for (raw in Json.list(cases["matches"])) {
            val test = Json.row(raw)
            val score = index.score(test["title"] as String, test["query"] as String)
            if (test["score"] == null) assertFalse("${test["title"]}/${test["query"]}", score.isFinite())
            else assertEquals("${test["title"]}/${test["query"]}", (test["score"] as Number).toDouble(), score, .000001)
        }
    }

    @Test
    fun `LBXX searches real Chinese titles without a prepopulated metadata cache`() = runBlocking {
        val fetcher = MetadataFetcher { url, _ ->
            val q = URI(url).rawQuery.split('&').associate {
                val pair = it.split('=', limit = 2)
                pair[0] to URLDecoder.decode(pair[1], "UTF-8")
            }["q"]
            val items = if (q == "蜡笔小新") listOf(
                mapOf("target_type" to "tv", "target" to mapOf("id" to "1431683", "title" to "蜡笔小新", "type" to "tv", "genres" to listOf("动画"))),
                mapOf("target_type" to "movie", "target" to mapOf("id" to "35693381", "title" to "蜡笔小新：好别致的影分身", "type" to "movie", "genres" to listOf("动画"))),
            ) else emptyList()
            HttpReply(200, Json.stringify(mapOf("total" to items.size, "items" to items)))
        }
        val data = DoubanDataSource(fetcher = fetcher, titleIndex = { index })
        assertEquals(listOf("db-1431683", "db-35693381"), data.search("LBXX").map { it.id })
        assertEquals(listOf("db-1431683", "db-35693381"), data.suggest("lbxx").map { it.id })
    }

    @Test
    fun `initial queries reject unrelated raw matches and keep English search`() = runBlocking {
        val fetcher = MetadataFetcher { url, _ ->
            val q = URI(url).rawQuery.split('&').associate {
                val pair = it.split('=', limit = 2)
                pair[0] to URLDecoder.decode(pair[1], "UTF-8")
            }["q"]
            val titles = when (q) {
                "LBXX" -> listOf("1" to "蜡笔小新", "9" to "暗域魔舰")
                "蜡笔小新" -> listOf("1" to "蜡笔小新")
                "Interstellar" -> listOf("10" to "星际穿越", "11" to "星际穿越：从科学到银幕")
                else -> emptyList()
            }
            HttpReply(200, Json.stringify(mapOf("total" to titles.size, "items" to titles.map { (id, title) ->
                mapOf("id" to id, "title" to title, "type" to "tv", "genres" to listOf("动画"))
            })))
        }
        val data = DoubanDataSource(fetcher = fetcher, titleIndex = { index })
        assertEquals(listOf("db-1"), data.search("LBXX").map { it.id })
        assertEquals(listOf("db-10", "db-11"), data.search("Interstellar").map { it.id })
    }

    @Test
    fun `blocked search falls back to identity hints and reads canonical TV metadata`() = runBlocking {
        val requested = ArrayList<String>()
        val fetcher = MetadataFetcher { url, _ ->
            val uri = URI(url)
            requested.add(uri.path)
            val q = uri.rawQuery?.split('&')?.associate {
                val pair = it.split('=', limit = 2)
                pair[0] to URLDecoder.decode(pair[1], "UTF-8")
            }?.get("q")
            when {
                uri.path.endsWith("/search/movie") -> HttpReply(403, "{}")
                uri.path == "/j/subject_suggest" -> HttpReply(200, Json.stringify(if (q == "蜡笔小新") listOf(
                    mapOf("id" to "1431683", "type" to "movie", "url" to "https://movie.douban.com/subject/1431683/"),
                    mapOf("id" to "100", "type" to "celebrity", "url" to "https://movie.douban.com/subject/100/"),
                ) else emptyList()))
                uri.path.endsWith("/movie/1431683") -> HttpReply(200, Json.stringify(mapOf("id" to "1431683", "title" to "蜡笔小新", "type" to "tv", "genres" to listOf("动画"), "episodes_count" to 10)))
                else -> error("Unexpected request ${uri.path}")
            }
        }
        val data = DoubanDataSource(fetcher = fetcher, titleIndex = { index })
        val found = data.search("LBXX")
        assertEquals(listOf("db-1431683"), found.map { it.id })
        assertEquals("anime", found.first().type.wire)
        assertEquals(null, found.first().episodes)
        assertFalse(requested.contains("/rexxar/api/v2/movie/100"))
    }

    @Test
    fun `an empty raw initials response cannot hide a failed Chinese query`() = runBlocking {
        val fetcher = MetadataFetcher { url, _ ->
            val uri = URI(url)
            val query = uri.rawQuery?.split('&')?.associate {
                val pair = it.split('=', limit = 2)
                pair[0] to URLDecoder.decode(pair[1], "UTF-8")
            }?.get("q")
            when {
                uri.path.endsWith("/search/movie") -> if (query == "LBXX")
                    HttpReply(200, Json.stringify(mapOf("total" to 0, "items" to emptyList<Any>()))) else HttpReply(403, "{}")
                uri.path == "/j/subject_suggest" -> HttpReply(200, Json.stringify(listOf(
                    mapOf("id" to "1431683", "type" to "movie", "url" to "https://movie.douban.com/subject/1431683/"),
                )))
                uri.path.endsWith("/movie/1431683") -> HttpReply(400, "{}")
                else -> error("Unexpected request ${uri.path}")
            }
        }
        val data = DoubanDataSource(fetcher = fetcher, titleIndex = { index })
        val failure = runCatching { data.search("LBXX") }.exceptionOrNull()
        assertTrue("A failed Chinese query must remain an error", failure is DataError)
        assertEquals(DataErrorCode.UPSTREAM, (failure as DataError).code)
    }

    @Test
    fun `empty suggestion fallbacks do not turn blocked searches into empty results`() = runBlocking {
        val fetcher = MetadataFetcher { url, _ ->
            val uri = URI(url)
            when {
                uri.path.endsWith("/search/movie") -> HttpReply(403, "{}")
                uri.path == "/j/subject_suggest" -> HttpReply(200, "[]")
                uri.path == "/j/search_suggest" -> HttpReply(200, "{\"cards\":[]}")
                else -> error("Unexpected request ${uri.path}")
            }
        }
        val data = DoubanDataSource(fetcher = fetcher, titleIndex = { index })
        for (query in listOf("未命中的查询", "另一个查询")) {
            val failure = runCatching { data.search(query) }.exceptionOrNull()
            assertTrue("A blocked request must retain its retry action", failure is DataError)
            assertEquals(DataErrorCode.UPSTREAM, (failure as DataError).code)
        }
    }

    @Test
    fun `a search with no verified fallback retries the primary query immediately`() = runBlocking {
        var blocked = true
        val fetcher = MetadataFetcher { url, _ ->
            val uri = URI(url)
            when {
                uri.path.endsWith("/search/movie") -> if (blocked) HttpReply(403, "{}") else HttpReply(200, Json.stringify(mapOf(
                    "total" to 1, "items" to listOf(mapOf("id" to "26647087", "title" to "三体", "type" to "tv")),
                )))
                uri.path == "/j/subject_suggest" -> HttpReply(200, "[]")
                uri.path == "/j/search_suggest" -> HttpReply(200, "{\"cards\":[]}")
                else -> error("Unexpected request ${uri.path}")
            }
        }
        val data = DoubanDataSource(fetcher = fetcher, titleIndex = { index })
        assertTrue(runCatching { data.search("三体") }.exceptionOrNull() is DataError)
        blocked = false
        assertEquals(listOf("db-26647087"), data.search("三体").map { it.id })
    }
}
