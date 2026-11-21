package app.panda.tv.model

import app.panda.tv.data.DataError
import app.panda.tv.data.DataErrorCode

object Copy {
    fun fmt(template: String, vararg pairs: Pair<String, Any>): String {
        var out = template
        for ((k, v) in pairs) {
            out = out.replace("{$k}", v.toString())
        }
        return out
    }

    object App {
        const val NAME = "Panda"
        const val VERSION = "版本 {v}"
    }

    object Nav {
        const val HOME = "首页"
        const val TV = "剧集"
        const val MOVIE = "电影"
        const val VARIETY = "综艺"
        const val ANIME = "动漫"
        const val DOC = "纪录片"
        const val ME = "我的"
        const val SETTINGS = "设置"

        fun of(type: MediaType): String = when (type) {
            MediaType.TV -> TV
            MediaType.MOVIE -> MOVIE
            MediaType.VARIETY -> VARIETY
            MediaType.ANIME -> ANIME
            MediaType.DOC -> DOC
        }
    }

    object Action {
        const val PLAY = "播放"
        const val RESUME = "继续播放"
        const val RESUME_EPISODE = "继续播放 第{n}{unit}"
        const val FAVORITE = "收藏"
        const val FAVORITED = "已收藏"
        const val DETAIL = "详情"
        const val MORE = "更多"
        const val EXPAND = "展开"
        const val COLLAPSE = "收起"
        const val RETRY = "重试"
        const val CANCEL = "取消"
        const val CONFIRM = "确定"
        const val CLEAR = "清空"
        const val REMOVE = "移除"
        const val BACK = "返回"
        const val CLOSE = "关闭"
        const val CLEAR_INPUT = "清除"
        const val CLEAR_FILTERS = "清除筛选"
    }

    object Status {
        const val EPISODE = "第{n}{unit}"
        const val REMAINING = "剩余{n}分钟"
        const val FINISHED = "已看完"
        const val MINUTES = "{n}分钟"
        const val RANGE = "{a}-{b}"
    }

    object Home {
        const val CONTINUE = "继续观看"
    }

    object Channel {
        const val GENRE = "类型"
        const val REGION = "地区"
        const val YEAR = "年份"
        const val ALL = "全部"
        const val SORT_HOT = "最热"
        const val SORT_NEW = "最新"
        const val SORT_SCORE = "高分"
        const val EMPTY = "暂无内容"
        const val END = "没有更多了"
        const val LOADING_MORE = "正在加载更多"
        const val LOAD_MORE_FAILED = "下一页加载失败"
    }

    object Detail {
        const val EPISODES = "选集"
        const val CAST = "演职员"
        const val RELATED = "相关推荐"
        const val DIRECTOR = "导演"
        const val STARRING = "主演"
    }

    object Search {
        const val PLACEHOLDER = "搜索片名、导演、演员"
        const val LABEL = "搜索"
        const val RECENT = "最近搜索"
        const val HOT = "热搜"
        const val RESULTS = "搜索结果"
        const val EMPTY = "没有找到相关内容"
    }

    object Me {
        const val FAVORITES = "收藏"
        const val HISTORY = "历史"
        const val TODAY = "今天"
        const val YESTERDAY = "昨天"
        const val EARLIER = "更早"
        const val EMPTY_FAVORITES = "还没有收藏"
        const val EMPTY_HISTORY = "还没有观看记录"
        const val CLEAR_HISTORY_TITLE = "清空观看历史？"
    }

    object SettingsCopy {
        const val TITLE = "设置"
        const val PLAYBACK = "播放"
        const val AUTO_NEXT = "自动播放下一集"
        const val SKIP_INTRO = "自动跳过片头片尾"
        const val QUALITY = "默认清晰度"
        const val SPEED = "默认倍速"
        const val DATA = "数据"
        const val CLEAR_HISTORY = "清空观看历史"
        const val CLEAR_SEARCHES = "清空搜索记录"
        const val ABOUT = "关于"
        const val CHECK_UPDATE = "检查更新"
        const val CLEAR_SEARCHES_TITLE = "清空搜索记录？"
    }

    object Player {
        const val PLAY = "播放"
        const val PAUSE = "暂停"
        const val NEXT = "下一集"
        const val SPEED = "倍速"
        const val QUALITY = "清晰度"
        const val EPISODES = "选集"
        const val SKIP_INTRO = "跳过片头"
        const val UP_NEXT = "{n}秒后播放"
        const val PLAY_NOW = "立即播放"
        const val ERROR = "播放失败"
        const val BUFFERING = "正在缓冲"
        const val PREPARING = "正在准备播放"
        const val SEEK_TO = "跳至 {time}"
        const val SECONDS = "{n}秒"
        const val TIMES = "{n}×"
    }

    object Toast {
        const val FAVORITED = "已收藏"
        const val UNFAVORITED = "已取消收藏"
        const val REMOVED = "已移除"
        const val CLEARED = "已清空"
    }

    object State {
        const val ERROR = "加载失败"
        const val OFFLINE = "网络未连接"
    }

    object Extra {
        const val SEARCH_INITIALS_PLACEHOLDER = "片名 / 首字母"
        const val LOADING = "加载中"
        const val LOAD_MORE = "加载更多"
        const val SAVE_ERROR = "保存失败"
        const val UNAVAILABLE = "暂时无法连接，请重试"
        const val SOURCE_UNAVAILABLE = "未找到可用片源"
        const val NO_SOURCE_YET = "该影片没有片源，请稍后再试"
        const val CHECKING_SOURCES = "正在查找片源"
        const val PAGE_NOT_FOUND = "页面不存在"
        const val UNKNOWN_ERROR = "操作失败，请重试"
        const val UPDATE_UNAVAILABLE = "更新服务未配置"
        const val INVALID_INPUT = "操作参数无效"
        const val NOT_FOUND = "未找到这部影片"
        const val TIMEOUT = "连接超时，请重试"
        const val RATE_LIMITED = "请求较多，请稍后重试"
        const val PARTIAL_METADATA = "部分信息加载失败"
        const val CACHED_METADATA = "正在显示已保存的信息"
        const val HOT_SEARCH_SOURCE = "百度影视热搜"
        const val STATE_CORRUPT = "本机数据读取失败"
        const val UNSUPPORTED_PLAYBACK = "此设备无法播放该视频"
        const val PLAYER_RETRY = "播放失败，请重试"
        const val RESTORING_SOURCE = "正在重新连接"
        const val NO_EPISODE = "未找到这一集的可用片源"
        const val LINE = "线路"
        const val SWITCHING_LINE = "正在切换线路"
        const val LINE_SWITCH_FAILED = "切换未成功，保留当前线路"
        const val PERSON_WORKS = "全部作品"
        const val PERSON_NOT_FOUND = "未找到这位影人"

        val ALL_SAFE = setOf(
            LOADING, LOAD_MORE, SAVE_ERROR, UNAVAILABLE, SOURCE_UNAVAILABLE,
            NO_SOURCE_YET, CHECKING_SOURCES,
            PAGE_NOT_FOUND, UNKNOWN_ERROR, UPDATE_UNAVAILABLE, INVALID_INPUT,
            NOT_FOUND, TIMEOUT, RATE_LIMITED, PARTIAL_METADATA, CACHED_METADATA,
            HOT_SEARCH_SOURCE, STATE_CORRUPT, UNSUPPORTED_PLAYBACK, PLAYER_RETRY,
            RESTORING_SOURCE, NO_EPISODE, LINE, SWITCHING_LINE, PERSON_WORKS,
            PERSON_NOT_FOUND, State.OFFLINE, State.ERROR,
        )
    }

    object Data {
        const val HOME_HOT_TV = "热播剧集"
        const val HOME_NEW_MOVIE = "最新电影"
        const val RANK_TV = "剧集榜"
        const val RANK_MOVIE = "电影榜"
        const val RANK_ANIME = "动漫榜"
    }

    fun errorText(error: Throwable?): String {
        if (error is DataError) {
            return when (error.code) {
                DataErrorCode.INVALID_INPUT -> Extra.INVALID_INPUT
                DataErrorCode.NOT_FOUND -> Extra.NOT_FOUND
                DataErrorCode.NETWORK -> State.OFFLINE
                DataErrorCode.TIMEOUT -> Extra.TIMEOUT
                DataErrorCode.RATE_LIMITED -> Extra.RATE_LIMITED
                DataErrorCode.UPSTREAM,
                DataErrorCode.INVALID_RESPONSE,
                DataErrorCode.UNAVAILABLE -> Extra.UNAVAILABLE
                DataErrorCode.STORAGE -> Extra.SAVE_ERROR
            }
        }
        val msg = error?.message.orEmpty()
        if (msg in Extra.ALL_SAFE) return msg
        return State.ERROR
    }
}
