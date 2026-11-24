package app.panda.tv

import app.panda.tv.data.HotSearch
import app.panda.tv.data.Normalize
import app.panda.tv.data.Taxonomy
import app.panda.tv.model.Adult
import app.panda.tv.model.HistoryEntry
import app.panda.tv.model.Json
import app.panda.tv.model.MediaItem
import app.panda.tv.model.MediaType
import app.panda.tv.model.Playback
import app.panda.tv.model.Rules
import app.panda.tv.model.Settings
import app.panda.tv.playback.Candidate
import app.panda.tv.playback.DeliveryScore
import app.panda.tv.playback.DeliverySpeed
import app.panda.tv.playback.SourceOrderScore
import app.panda.tv.playback.EpisodeRange
import app.panda.tv.playback.PictureSize
import app.panda.tv.playback.PlaySource
import app.panda.tv.playback.PlaybackMatchers
import app.panda.tv.playback.PlaylistFilter
import app.panda.tv.playback.RawVod
import app.panda.tv.playback.SourceRulesLoader
import app.panda.tv.playback.WorkHints
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.util.Base64

class GoldenParityTest {
    private val vectors: Map<String, Any?> by lazy {
        val stream = requireNotNull(javaClass.classLoader?.getResourceAsStream("golden-vectors.json")) {
            "Missing golden-vectors.json test resource"
        }
        Json.parseObject(stream.bufferedReader(Charsets.UTF_8).readText())
    }

    private val sourceRules by lazy {
        val assetsFile = listOf(
            File("src/main/assets/play-sources.json"),
            File("app/src/main/assets/play-sources.json"),
        ).first { it.exists() }
        SourceRulesLoader.validate(assetsFile.readText(Charsets.UTF_8))
    }

    private fun evidenceFile(name: String): File? {
        return listOf(
            File("../docs/evidence/manifest-$name.m3u8"),
            File("../../docs/evidence/manifest-$name.m3u8"),
        ).firstOrNull { it.exists() }
    }

    @Test
    fun `rules match desktop contract`() {
        val r = Json.row(vectors["rules"])
        val base = MediaItem(
            id = "db-26647087", title = "三体", type = MediaType.TV, genres = listOf("剧情", "科幻"),
            year = 2023, region = "中国大陆", score = 8.8, episodes = 30, status = "更新至30集",
            poster = "https://img1.doubanio.com/a.jpg",
        )
        val film = MediaItem(
            id = "db-1292052", title = "肖申克的救赎", type = MediaType.MOVIE, genres = listOf("剧情", "犯罪"),
            year = 1994, region = "美国", score = 9.7, runtime = 142,
            poster = "https://img2.doubanio.com/b.jpg", backdrop = "https://img2.doubanio.com/bg.jpg",
        )
        val sampleH = HistoryEntry("db-26647087", 5, 720.0, 2700.0, 1700000000000L)
        val finishedH = HistoryEntry("db-1292052", 1, 8300.0, 8520.0, 1700000000000L)

        assertEquals(
            Json.list(r["scoreText"]),
            listOf(Rules.scoreText(base), Rules.scoreText(base.copy(score = null)), Rules.scoreText(base.copy(score = 0.0))),
        )
        assertEquals(
            Json.list(r["statusText"]),
            listOf(Rules.statusText(base), Rules.statusText(film), Rules.statusText(film.copy(runtime = null))),
        )
        assertEquals(
            Json.list(r["episodeLabel"]),
            listOf(Rules.episodeLabel(base, 5), Rules.episodeLabel(base.copy(unit = "期"), 3)),
        )
        assertEquals(
            Json.list(r["episodeHeading"]),
            listOf(Rules.episodeHeading(base, 5), Rules.episodeHeading(film, 1)),
        )
        assertEquals(
            Json.list(r["metaParts"]),
            listOf(Rules.metaParts(base, region = true, genres = 3), Rules.metaParts(film, region = false, genres = 2)),
        )
        assertEquals(
            Json.list(r["isFinished"]),
            listOf(Rules.isFinished(95.0, 100.0), Rules.isFinished(96.0, 100.0), Rules.isFinished(0.0, 0.0)),
        )
        assertEquals(
            Json.list(r["progressPercent"]).map { (it as Number).toInt() },
            listOf(Rules.progressPercent(sampleH), Rules.progressPercent(0.0, 0.0)),
        )
        assertEquals(
            Json.list(r["progressText"]),
            listOf(Rules.progressText(base, sampleH), Rules.progressText(film, finishedH)),
        )
        assertEquals(
            Json.list(r["playLabel"]),
            listOf(Rules.playLabel(base, null), Rules.playLabel(base, sampleH), Rules.playLabel(film, finishedH)),
        )
        assertEquals(
            Json.list(r["resumePosition"]).map { (it as Number).toDouble() },
            listOf(Rules.resumePosition(sampleH, 5), Rules.resumePosition(sampleH, 6), Rules.resumePosition(finishedH, 1)),
        )
        assertEquals(
            Json.list(r["clock"]),
            listOf(Rules.clock(0.0), Rules.clock(307.0), Rules.clock(3723.0), Rules.clock(-5.0)),
        )
        assertEquals(
            Json.list(r["upNextSeconds"]).map { (it as? Number)?.toInt() },
            listOf(
                Rules.upNextSeconds(2690.5, 2700.0, hasNext = true, autoNext = true, cancelled = false),
                Rules.upNextSeconds(2680.0, 2700.0, hasNext = true, autoNext = true, cancelled = false),
                Rules.upNextSeconds(2695.0, 2700.0, hasNext = true, autoNext = true, cancelled = true),
            ),
        )
        val epRanges = Json.list(r["episodeRanges"]).map { list ->
            Json.list(list).map { m ->
                val rm = Json.row(m)
                app.panda.tv.model.EpisodeRange((rm["from"] as Number).toInt(), (rm["to"] as Number).toInt(), rm["label"] as String)
            }
        }
        assertEquals(epRanges[0], Rules.episodeRanges(50))
        assertEquals(epRanges[1], Rules.episodeRanges(125))
    }

    @Test
    fun `douban normalization and credits match desktop`() {
        val n = Json.row(vectors["normalize"])
        for (c in Json.list(n["imageUrl"])) {
            val row = Json.row(c)
            assertEquals(row["output"], Normalize.imageUrl(row["input"]))
        }
        for (c in Json.list(n["portraitUrl"])) {
            val row = Json.row(c)
            assertEquals(row["output"], Normalize.portraitUrl(row["input"]))
        }
        for (c in Json.list(n["subtitleParts"])) {
            val row = Json.row(c)
            val exp = Json.row(row["output"])
            val got = Normalize.subtitleParts(row["input"])
            assertEquals((exp["year"] as? Number)?.toInt(), got.year)
            assertEquals(exp["region"], got.region)
            assertEquals(Json.list(exp["genres"]), got.genres)
        }
        for (c in Json.list(n["mediaType"])) {
            val row = Json.row(c)
            val got = Normalize.mediaType(
                row["kind"] as String,
                Json.list(row["genres"]).map { it as String },
                row["isShow"] == true,
            )
            assertEquals(row["output"], got.wire)
        }
        for (c in Json.list(n["normalize"])) {
            val row = Json.row(c)
            val got = Normalize.normalize(row["input"])
            val exp = row["output"]
            if (exp == null) {
                assertNull(got)
            } else {
                assertNotNull(got)
                val em = Json.row(exp)
                val ei = Json.row(em["item"])
                assertEquals(ei["id"], got!!.item.id)
                assertEquals(ei["title"], got.item.title)
                assertEquals(ei["type"], got.item.type.wire)
                assertEquals(Json.list(ei["genres"]), got.item.genres)
                assertEquals(ei["poster"], got.item.poster)
                assertEquals((em["totalEpisodes"] as? Number)?.toInt(), got.totalEpisodes)
                assertEquals(em["aliases"]?.let { Json.list(it) }, got.aliases)
            }
        }
        val expectedCredits = Json.row(n["principalCredits"])
        val creditsInput = mapOf(
            "items" to listOf(
                mapOf("id" to "1313742", "name" to "于和伟", "category" to "演员", "simple_character" to "饰 史强", "avatar" to mapOf("normal" to "https://img1.doubanio.com/view/celebrity/raw/public/p1.jpg")),
                mapOf("id" to "1001", "name" to "杨磊", "category" to "导演", "simple_character" to "导演", "avatar" to mapOf("normal" to "https://img1.doubanio.com/view/celebrity/raw/public/p2.jpg")),
                mapOf("id" to "1001", "name" to "杨磊", "category" to "编剧", "simple_character" to "编剧", "avatar" to mapOf("normal" to "https://img1.doubanio.com/view/celebrity/raw/public/p2.jpg")),
                mapOf("id" to "1002", "name" to "无照影人", "category" to "演员", "simple_character" to "饰 配角", "avatar" to mapOf("normal" to "https://img1.doubanio.com/f/movie/8dd0c794499fe925ae2ae89ee30cd225750457b4/pics/movie/celebrity-default-medium.png")),
            )
        )
        val pc = Normalize.principalCredits(creditsInput)
        assertEquals(Json.list(expectedCredits["people"]).size, pc.people.size)
        assertEquals("导演 / 编剧", pc.people[1].role)
        assertNull(pc.people[2].photo)
        assertEquals(2, pc.cast.size)

        val lp = Normalize.landscapePhoto(
            mapOf(
                "photos" to listOf(
                    mapOf("image" to mapOf("large" to mapOf("url" to "https://img1.doubanio.com/small.jpg", "width" to 500, "height" to 280))),
                    mapOf("image" to mapOf("large" to mapOf("url" to "https://img1.doubanio.com/tall.jpg", "width" to 900, "height" to 1200))),
                    mapOf("image" to mapOf("is_animated" to true, "large" to mapOf("url" to "https://img1.doubanio.com/gif.jpg", "width" to 1280, "height" to 720))),
                    mapOf("image" to mapOf("large" to mapOf("url" to "https://img1.doubanio.com/good.jpg", "width" to 1280, "height" to 720))),
                )
            )
        )
        assertEquals(n["landscapePhoto"], lp)
    }

    @Test
    fun `taxonomy and hot search match desktop`() {
        val tax = Json.row(vectors["taxonomy"])
        assertEquals(Json.list(tax["yearChoices2026"]), Taxonomy.yearChoices(2026))
        for (c in Json.list(tax["yearSpan"])) {
            val row = Json.row(c)
            val got = Taxonomy.yearSpan(row["input"] as String)
            val exp = row["output"]
            if (exp == null) assertNull(got) else {
                val arr = Json.list(exp)
                assertEquals((arr[0] as Number).toInt() to (arr[1] as Number).toInt(), got)
            }
        }
        for (c in Json.list(tax["matchesYear"])) {
            val row = Json.row(c)
            assertEquals(row["output"], Taxonomy.matchesYear((row["year"] as? Number)?.toInt(), row["selected"] as? String))
        }
        for (c in Json.list(tax["matchesRegion"])) {
            val row = Json.row(c)
            assertEquals(row["output"], Taxonomy.matchesRegion(row["region"] as? String, row["selected"] as? String))
        }
        val gCounts = Json.row(tax["genreCounts"])
        for ((k, v) in gCounts) {
            assertEquals((v as Number).toInt(), Taxonomy.GENRES[MediaType.fromWire(k)!!]!!.size)
        }
        val rCounts = Json.row(tax["regionCounts"])
        for ((k, v) in rCounts) {
            assertEquals((v as Number).toInt(), Taxonomy.REGIONS[MediaType.fromWire(k)!!]!!.size)
        }

        val hs = Json.row(vectors["hotSearch"])
        val rawHot = mapOf(
            "success" to true,
            "data" to mapOf(
                "cards" to listOf(
                    mapOf(
                        "component" to "tabImgInfoList",
                        "content" to listOf(
                            mapOf(
                                "content" to listOf(
                                    mapOf("title" to "电影甲", "Sa" to "fyb_movie", "hotScore" to mapOf("desc" to "热搜指数", "value" to "500")),
                                    mapOf("title" to "电影乙", "Sa" to "fyb_movie", "hotScore" to mapOf("desc" to "热搜指数", "value" to "900")),
                                    mapOf("title" to "生活话题", "Sa" to "fyb_realtime", "hotScore" to mapOf("desc" to "热搜指数", "value" to "1000")),
                                )
                            )
                        )
                    )
                )
            )
        )
        val movieHot = HotSearch.hotQueries(rawHot, "movie")
        assertEquals(2, movieHot.size)
        assertEquals(Json.list(hs["combined"]), HotSearch.combineHotQueries(listOf(listOf(app.panda.tv.data.HotQuery("电影甲", 500.0)), listOf(app.panda.tv.data.HotQuery("剧集乙", 600.0), app.panda.tv.data.HotQuery("电影甲", 200.0)))))
    }

    @Test
    fun `playback matching numbering and ranking match desktop`() {
        val svc = Json.row(vectors["service"])
        for (c in Json.list(svc["normalizedTitle"])) {
            val r = Json.row(c)
            assertEquals(r["output"], PlaybackMatchers.normalizedTitle(r["input"] as String))
        }
        for (c in Json.list(svc["titleKey"])) {
            val r = Json.row(c)
            val o = Json.row(r["output"])
            val got = PlaybackMatchers.titleKey(r["input"] as String)
            assertEquals(o["base"], got.base)
            assertEquals((o["season"] as Number).toInt(), got.season)
            assertEquals(o["dubbed"], got.dubbed)
        }
        for (c in Json.list(svc["classifySourceType"])) {
            val r = Json.row(c)
            assertEquals(r["output"], PlaybackMatchers.classifySourceType(r["input"] as String)?.wire)
        }
        for (c in Json.list(svc["episodeRange"])) {
            val r = Json.row(c)
            val got = PlaybackMatchers.episodeRange(r["input"] as String)
            val exp = r["output"]
            if (exp == null) assertNull(got) else {
                val em = Json.row(exp)
                assertEquals(EpisodeRange(em["name"] as String, (em["first"] as Number).toInt(), (em["last"] as Number).toInt()), got)
            }
        }
        for (c in Json.list(svc["matchRecord"])) {
            val r = Json.row(c)
            val itRow = Json.row(r["item"])
            val item = MediaItem(
                id = itRow["id"] as String,
                title = itRow["title"] as String,
                type = MediaType.fromWire(itRow["type"] as String)!!,
                genres = emptyList(),
                year = (itRow["year"] as? Number)?.toInt(),
                region = itRow["region"] as? String,
            )
            val rawRow = Json.row(r["raw"])
            val rawVod = RawVod(null, rawRow["vod_name"] as? String, rawRow["vod_year"] as? String, rawRow["type_name"] as? String, null, null, rawRow["vod_area"] as? String)
            val hRow = Json.row(r["hints"])
            val hints = WorkHints(
                aliases = (hRow["aliases"] as? List<*>)?.map { it as String },
                totalEpisodes = (hRow["totalEpisodes"] as? Number)?.toInt(),
            )
            val got = PlaybackMatchers.matchRecord(item, rawVod, hints)
            val exp = r["output"]
            if (exp == null) assertNull(got) else {
                val em = Json.row(exp)
                assertNotNull(got)
                assertEquals(em["weak"] == true, got!!.weak)
                val rng = em["range"]?.let { Json.row(it) }
                if (rng == null) assertNull(got.range)
                else assertEquals(EpisodeRange(rng["name"] as String, (rng["first"] as Number).toInt(), (rng["last"] as Number).toInt()), got.range)
            }
        }
        for (c in Json.list(svc["adultShelf"])) {
            val r = Json.row(c)
            assertEquals(r["input"] as String, r["output"], Adult.shelf(r["input"] as String))
        }
        for (c in Json.list(svc["searchTerms"])) {
            val r = Json.row(c)
            assertEquals(Json.list(r["output"]), PlaybackMatchers.searchTerms(r["input"] as String))
        }
        val run4Aliases = listOf("凡人修仙传 第177-228集", "凡人修仙传 年番4之慕兰之战", "凡人修仙传：慕兰之战", "凡人修仙传 第五季", "A Record of a Mortal's Journey to Immortality")
        assertEquals(Json.list(svc["workTerms"]), PlaybackMatchers.workTerms("凡人修仙传 年番4", run4Aliases))

        val parsed = PlaybackMatchers.parseLines(
            "dyttm3u8$$\$yun123$$\$dytt",
            "第01集\$https://a.com/1.m3u8#第30集已完结\$https://a.com/30.m3u8#第240集上\$https://a.com/240a.m3u8#预告\$https://a.com/t.m3u8$$\$x\$https://y.com/1.m3u8$$\$HD\$//b.com/v.mp4",
        )
        assertEquals(Json.list(svc["parseLines"]).size, parsed.size)
        assertEquals("https://b.com/v.mp4", parsed[1].episodes[0].url)
        assertEquals("mp4", parsed[1].episodes[0].format)

        val mirrorVector = Json.row(svc["mirrorLines"])
        val mirrorLines = PlaybackMatchers.parseLines("mp4", mirrorVector["input"] as String)
        val expectedMirrors = Json.list(mirrorVector["output"]).map(Json::row)
        assertEquals(expectedMirrors.size, mirrorLines.size)
        for ((index, line) in mirrorLines.withIndex()) {
            val expected = Json.list(expectedMirrors[index]["episodes"]).map(Json::row)
            assertEquals(expected.map { it["url"] }, line.episodes.map { it.url })
            assertEquals(expected.map { (it["number"] as Number).toInt() }, line.episodes.map { it.number })
            assertTrue(PlaybackMatchers.numbering(line).numeric)
        }

        val variants = PlaybackMatchers.manifestVariants(
            "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nhttp://[bad\n#EXT-X-STREAM-INF:BANDWIDTH=1500\njavascript:alert(1)\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1920x1080\n1080/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1280x720\n720/index.m3u8\n",
            "https://cdn.example/master.m3u8",
        )
        val expectedVariants = Json.list(svc["manifestVariants"]).map { Json.row(it) }
        assertEquals(expectedVariants.size, variants.size)
        for (i in expectedVariants.indices) {
            assertEquals(expectedVariants[i]["url"], variants[i].url)
            assertEquals(expectedVariants[i]["quality"], variants[i].quality?.label)
            assertEquals((expectedVariants[i]["bandwidth"] as Number).toInt(), variants[i].bandwidth)
        }

        val vRef = PlaybackMatchers.parseLines("m3u8", listOf("先导片上", "先导片下", "第20251023期", "第20251025期", "第20251026期", "第20260104期特别加更").mapIndexed { i, t -> "$t\$https://example.com/r$i.m3u8" }.joinToString("#"))[0]
        val vOther = PlaybackMatchers.parseLines("m3u8", listOf("20251018", "20251025上", "20260104(特别加更)", "第20251018期先导片上", "第20251019期先导片下").mapIndexed { i, t -> "$t\$https://example.com/o$i.m3u8" }.joinToString("#"))[0]
        for (c in Json.list(svc["sameIssue"])) {
            val r = Json.row(c)
            val wanted = vRef.episodes.first { it.title == r["wanted"] }
            assertEquals(r["found"], PlaybackMatchers.sameIssue(wanted, vRef, vOther)?.title)
        }
    }

    @Test
    fun `playlist ad filter matches desktop rules and captured manifests`() {
        val f = Json.row(vectors["filter"])
        val baseUrl = "https://vip.ffzy-online2.com/main.m3u8"

        for (c in Json.list(f["cases"])) {
            val row = Json.row(c)
            val src = sourceRules.sources.first { it.key == row["sourceKey"] }
            val customRules = sourceRules.copy(
                maxDropRatio = (row["maxDropRatio"] as Number).toDouble(),
                foreignBlockMaxSeconds = (row["foreignMax"] as Number).toDouble(),
            )
            val got = PlaylistFilter.filterPlaylist(
                text = row["text"] as String,
                baseUrl = baseUrl,
                source = src,
                rules = customRules,
                preserveTimeline = row["preserve"] == true,
            )
            val exp = Json.row(row["expected"])
            assertEquals("${row["label"]} reason", exp["reason"], got.reason)
            assertEquals("${row["label"]} removedSegments", (exp["removedSegments"] as Number).toInt(), got.removedSegments)
            assertEquals("${row["label"]} removedSeconds", (exp["removedSeconds"] as Number).toDouble(), got.removedSeconds, 0.001)
            assertEquals("${row["label"]} evidence", Json.list(exp["evidence"]), got.evidence)
        }

        for (fix in Json.list(f["fixtures"])) {
            val row = Json.row(fix)
            val name = row["name"] as String
            val file = evidenceFile(name) ?: continue
            val src = sourceRules.sources.first { it.key == row["sourceKey"] }
            val got = PlaylistFilter.filterPlaylist(file.readText(Charsets.UTF_8), baseUrl, src, sourceRules)
            assertEquals("$name reason", row["reason"], got.reason)
            assertEquals("$name removedSegments", (row["removedSegments"] as Number).toInt(), got.removedSegments)
            assertEquals("$name removedSeconds", (row["removedSeconds"] as Number).toDouble(), got.removedSeconds, 0.001)
            assertEquals("$name evidence", Json.list(row["evidence"]), got.evidence)
        }
    }

    @Test
    fun `download headroom and source preference match desktop`() {
        val delivery = Json.row(vectors["delivery"])
        for (c in Json.list(delivery["margin"])) {
            val row = Json.row(c)
            val input = Json.row(row["input"])
            val actual = DeliverySpeed.playbackMargin(
                (input["seconds"] as? Number)?.toDouble(), (input["length"] as? Number)?.toLong(),
                (input["received"] as Number).toLong(), (input["elapsedMs"] as Number).toLong(), input["complete"] == true,
            )
            if (row["output"] == null) assertNull(actual)
            else assertEquals((row["output"] as Number).toDouble(), actual!!, 0.000001)
        }
        for (c in Json.list(delivery["choices"])) {
            val row = Json.row(c)
            fun score(key: String): DeliveryScore {
                val s = Json.row(row[key])
                return DeliveryScore((s["picture"] as Number).toDouble(), (s["margin"] as? Number)?.toDouble())
            }
            assertEquals((row["output"] as Number).toInt(), DeliverySpeed.compare(score("a"), score("b")))
        }
        for (c in Json.list(delivery["sourceOrder"])) {
            val row = Json.row(c)
            fun score(key: String): SourceOrderScore {
                val s = Json.row(row[key])
                return SourceOrderScore(s["behind"] == true, s["previous"] == true, s["winner"] == true)
            }
            assertEquals((row["output"] as Number).toInt(), DeliverySpeed.compareSourceOrder(score("a"), score("b"), row["retry"] == true))
        }
    }

    @Test
    fun `mpeg-ts h264 picture parser and aes decryption match desktop`() {
        val pic = Json.row(vectors["picture"])
        for (h in Json.list(pic["heads"])) {
            val row = Json.row(h)
            val raw = Base64.getDecoder().decode(row["head"] as String)
            val got = PictureSize.pictureOf(raw)
            val exp = row["expected"]
            if (exp == null) {
                assertNull(got)
            } else {
                val em = Json.row(exp)
                assertNotNull(got)
                assertEquals((em["width"] as Number).toInt(), got!!.width)
                assertEquals((em["height"] as Number).toInt(), got.height)
            }
        }
        assertNull(PictureSize.pictureOf("<html>not a segment</html>".toByteArray(Charsets.UTF_8)))

        val enc = Json.row(pic["encrypted"])
        fun hex(s: String): ByteArray = ByteArray(s.length / 2) { i -> s.substring(i * 2, i * 2 + 2).toInt(16).toByte() }
        val key = hex(enc["keyHex"] as String)
        val iv = hex(enc["ivHex"] as String)
        val sealed = Base64.getDecoder().decode(enc["sealedBase64"] as String)
        val clear = PictureSize.clearHead(sealed, key, iv)
        val gotPic = PictureSize.pictureOf(clear)
        val expPic = Json.row(enc["expectedPicture"])
        assertNotNull(gotPic)
        assertEquals((expPic["width"] as Number).toInt(), gotPic!!.width)
        assertEquals((expPic["height"] as Number).toInt(), gotPic.height)
        assertEquals(0, PictureSize.clearHead(sealed.copyOf(10), key, iv).size)
    }
}
