package app.panda.tv.data

import app.panda.tv.model.MediaType
import java.util.Calendar

data class Lane(val kind: String, val tags: List<String>)

object Taxonomy {
    val LANES: Map<MediaType, List<Lane>> = mapOf(
        MediaType.TV to listOf(Lane("tv", listOf("电视剧"))),
        MediaType.MOVIE to listOf(Lane("movie", emptyList())),
        MediaType.VARIETY to listOf(Lane("tv", listOf("综艺"))),
        MediaType.ANIME to listOf(Lane("tv", listOf("动画")), Lane("movie", listOf("动画"))),
        MediaType.DOC to listOf(Lane("tv", listOf("纪录片")), Lane("movie", listOf("纪录片"))),
    )

    private fun words(s: String): List<String> = s.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }

    val GENRES: Map<MediaType, List<String>> = mapOf(
        MediaType.TV to words(
            "剧情 爱情 喜剧 悬疑 古装 都市 家庭 犯罪 刑侦 奇幻 科幻 武侠 仙侠 玄幻 历史 战争 年代 青春 校园 职场 " +
                "动作 谍战 军旅 抗战 医疗 律政 商战 农村 宫廷 宫斗 权谋 穿越 重生 甜宠 偶像 励志 探案 推理 惊悚 恐怖 " +
                "冒险 警匪 黑帮 反腐 民国 革命 神话 女性 婚姻 亲情 友情 成长 治愈 现实 社会 伦理 复仇 创业 运动 音乐 " +
                "传记 灾难 丧尸 吸血鬼 超级英雄 政治 西部 情景喜剧 黑色幽默 短剧 迷你剧 小说改编"
        ),
        MediaType.MOVIE to words(
            "剧情 喜剧 爱情 动作 科幻 悬疑 犯罪 惊悚 恐怖 冒险 奇幻 动画 战争 历史 传记 音乐 歌舞 武侠 古装 灾难 " +
                "西部 家庭 儿童 运动 青春 校园 文艺 纪录片 短片 黑色幽默 公路 警匪 黑帮 功夫 谍战 特工 间谍 推理 侦探 烧脑 " +
                "反转 心理 人性 社会 现实 女性 励志 治愈 温情 亲情 友情 成长 浪漫 搞笑 魔幻 史诗 神话 超级英雄 漫威 DC " +
                "迪士尼 皮克斯 吉卜力 丧尸 吸血鬼 怪物 灵异 外星人 机器人 人工智能 太空 末日 赛博朋克 穿越 恐龙 复仇 监狱 越狱 " +
                "律政 政治 宗教 军事 二战 抗战 赛车 美食 旅行 艺术 戏曲 默片 cult 黑色电影 独立电影 小说改编 真实事件改编 经典 " +
                "都市 农村 职场 医疗 年代 宫廷"
        ),
        MediaType.ANIME to words(
            "热血 冒险 搞笑 恋爱 校园 日常 治愈 奇幻 科幻 悬疑 推理 战斗 动作 机甲 机器人 运动 竞技 音乐 偶像 魔法 " +
                "魔幻 穿越 历史 战争 神话 武侠 玄幻 修仙 仙侠 古风 国风 青春 励志 成长 少女 后宫 百合 耽美 萌 喜剧 " +
                "爱情 家庭 儿童 少儿 亲子 童话 动物 科普 感人 温情 催泪 致郁 恐怖 惊悚 犯罪 侦探 吸血鬼 妖怪 忍者 超能力 " +
                "赛博朋克 太空 游戏 特摄 漫画改编 游戏改编 原创 泡面番 OVA 定格动画 3D 迪士尼 皮克斯 吉卜力 梦工厂 漫威 DC 高达 " +
                "柯南 哆啦A梦 黑色幽默 文艺 哲学 人性"
        ),
        MediaType.VARIETY to words(
            "真人秀 脱口秀 音乐 喜剧 搞笑 旅行 竞技 选秀 访谈 谈话 舞蹈 街舞 说唱 乐队 嘻哈 亲子 萌娃 恋爱 情感 职场 " +
                "文化 生活 游戏 推理 悬疑 密室 生存 偶像 明星 时尚 运动 体育 篮球 足球 汽车 辩论 演讲 表演 演技 相声 " +
                "文学 诗词 传统文化 纪实 历史 艺术 教育 歌舞 家庭 爱情 冒险 探险 自然 宠物 励志 治愈 成长 青春 校园 社会 " +
                "女性 军事"
        ),
        MediaType.DOC to words(
            "自然 人文 社会 历史 美食 饮食 地理 科学 宇宙 天文 太空 动物 植物 海洋 生态 环保 艺术 音乐 摇滚 舞蹈 " +
                "传记 人物 运动 体育 足球 军事 战争 二战 考古 文物 博物馆 建筑 设计 摄影 旅行 探险 犯罪 医疗 医学 健康 " +
                "教育 经济 金融 商业 政治 科技 文化 文学 生活 纪实 真实 宗教 哲学 心理 城市 农村 女性 儿童 家庭 灾难 " +
                "生物 人类 生命 时尚 新闻 传统 航空 物理 BBC NHK 国家地理 Netflix HBO PBS Discovery CCTV 央视"
        ),
    )

    private val COUNTRIES = words(
        "中国大陆 中国香港 中国台湾 日本 韩国 美国 英国 法国 德国 意大利 西班牙 印度 泰国 俄罗斯 加拿大 澳大利亚 " +
            "爱尔兰 瑞典 丹麦 挪威 芬兰 荷兰 比利时 瑞士 奥地利 波兰 捷克 匈牙利 葡萄牙 希腊 冰岛 土耳其 以色列 伊朗 新西兰 新加坡 " +
            "马来西亚 越南 菲律宾 印度尼西亚 巴西 墨西哥 阿根廷 南非"
    )
    val REGION_GROUPS = listOf("华语", "欧美")
    private val SPARSE: Map<MediaType, Set<String>> = mapOf(
        MediaType.VARIETY to words("冰岛 伊朗 越南 印度尼西亚").toSet()
    )

    val REGIONS: Map<MediaType, List<String>> = MediaType.values().associateWith { type ->
        val sparse = SPARSE[type] ?: emptySet()
        REGION_GROUPS + COUNTRIES.filter { it !in sparse }
    }

    private val DECADES = listOf(
        "2000年代" to 2000,
        "90年代" to 1990,
        "80年代" to 1980,
        "70年代" to 1970,
        "60年代" to 1960,
    )
    const val EARLIER = "更早"
    private const val FIRST_SINGLE_YEAR = 2010
    private val YEAR_REGEX = Regex("^(?:19|20)\\d{2}$")

    fun yearChoices(current: Int = Calendar.getInstance().get(Calendar.YEAR)): List<String> {
        val out = ArrayList<String>()
        for (y in current downTo FIRST_SINGLE_YEAR) out.add(y.toString())
        for ((label, _) in DECADES) out.add(label)
        out.add(EARLIER)
        return out
    }

    fun yearSpan(selected: String): Pair<Int, Int>? {
        if (YEAR_REGEX.matches(selected)) {
            val y = selected.toInt()
            return y to y
        }
        val decade = DECADES.firstOrNull { it.first == selected }
        if (decade != null) return decade.second to (decade.second + 9)
        if (selected == EARLIER) return 0 to (DECADES.last().second - 1)
        return null
    }

    fun matchesYear(year: Int?, selected: String?): Boolean {
        if (selected.isNullOrEmpty()) return true
        val span = yearSpan(selected) ?: return false
        return year != null && year in span.first..span.second
    }

    fun matchesRegion(region: String?, selected: String?): Boolean {
        if (selected.isNullOrEmpty() || selected in REGION_GROUPS) return true
        if (region.isNullOrEmpty()) return false
        return region.split(Regex("[\\s/]+")).any { it == selected }
    }
}
