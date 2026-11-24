// 数据契约：界面只认这一份类型。
//
// 真实接口长什么样都可以，在 src/main/data/ 里写一层转换，把它变成这里的形状；
// 组件、页面一律只用这里的类型，不直接碰接口返回的原始数据。
// 字段缺失时界面怎么显示：缺什么就不显示什么，绝不显示「暂无」「未知」。

import type { QUALITIES, SPEEDS } from './constants'

// ───────────────────────── 内容 ─────────────────────────

/** 五个频道，也是内容的五种类型 */
export type MediaType = 'tv' | 'movie' | 'variety' | 'anime' | 'doc'

export interface Person {
  name: string
  /** 原样显示在名字下面，例如「饰 沈知夏」。没有就不显示这一行 */
  role?: string
}

/** 一部片子。列表里和详情页用的是同一个类型：列表接口可以少给字段，少给的不显示 */
export interface MediaItem {
  // ── 一定有 ──
  id: string
  type: MediaType
  title: string
  /** 类型标签，按重要程度排序。可以是空数组 */
  genres: string[]
  /** 竖版海报（2:3）的地址，能直接放进 <img src>。没有图就给 null */
  poster: string | null
  /** 横版剧照（16:9）的地址。没有图就给 null */
  backdrop: string | null

  // ── 可能没有 ──
  /** 原名 / 外文名。只在详情页显示 */
  originalTitle?: string
  year?: number
  region?: string
  /** 评分，0–10。界面固定显示一位小数；没有或为 0 就不显示 */
  score?: number
  /** 现在能播放的集数。有这个字段 = 多集内容（显示选集）；没有 = 单片 */
  episodes?: number
  /** 集数的量词，默认「集」 */
  unit?: '集' | '期'
  /** 更新状态，由数据源给出成品文字：「全24集」「更新至8期」。界面原样显示，不自己拼 */
  status?: string
  /** 片长，单位是分钟（注意：观看历史里的 duration 单位是秒） */
  runtime?: number
  /** 海报左上角的角标：「独播」「首播」「新片」。最多 2 个字，超过的由转换层丢弃 */
  tag?: string
  /** 首页主推片名上方的小字：「本周主推」。只在主推区使用 */
  kicker?: string
  /** 一句话卖点，12 个字以内 */
  tagline?: string
  synopsis?: string
  directors?: string[]
  cast?: Person[]
  /** 每一集的标题，下标 0 是第 1 集。有这个字段时选集用「带标题的列表」样式，否则用数字格子 */
  episodeTitles?: string[]
}

// ───────────────────────── 首页 ─────────────────────────

export interface HomeFeed {
  /** 主推，3–5 部。每一部必须有 backdrop 或 poster */
  hero: MediaItem[]
  /** 栏目，按从上到下的顺序 */
  shelves: Shelf[]
}

export type Shelf = ContinueShelf | CardShelf | RankShelf

/** 「继续观看」的占位：只表示它排在第几个，内容来自本机的观看历史。没有可继续的内容时整个栏目不出现 */
export interface ContinueShelf {
  id: string
  kind: 'continue'
}

/** 一行卡片：poster 用竖版卡片，wide 用横版卡片 */
export interface CardShelf {
  id: string
  kind: 'poster' | 'wide'
  title: string
  /** 「更多」跳去的应用内路径，例如 /channel/tv。没有就不显示「更多」 */
  more?: string
  items: MediaItem[]
}

/** 排行榜：固定三个榜并排，每个榜 5 部 */
export interface RankShelf {
  id: string
  kind: 'rank'
  boards: RankBoard[]
}

export interface RankBoard {
  title: string
  more?: string
  items: MediaItem[]
}

// ───────────────────────── 频道 ─────────────────────────

export type ChannelSort = 'hot' | 'new' | 'score'

/** 频道页的筛选条件。同时也是地址栏里的查询参数：/channel/tv?genre=悬疑&sort=new */
export interface ChannelQuery {
  genre?: string
  region?: string
  year?: string
  sort: ChannelSort
}

/** 某个频道有哪些筛选项（不含「全部」，界面自己加在最前面）。regions 只有一项时不显示地区这一行 */
export interface ChannelFilters {
  genres: string[]
  regions: string[]
  /** 例如 ['2025', '2024', '2023', '更早'] */
  years: string[]
}

/** 分页结果。next 为 null 表示到底了 */
export interface Page<T> {
  items: T[]
  next: string | null
}

// ───────────────────────── 播放 ─────────────────────────

export type Quality = (typeof QUALITIES)[number]
export type Speed = (typeof SPEEDS)[number]

export interface Playback {
  /** 播放地址 */
  url: string
  /** hls 交给 hls.js，mp4 直接给 <video> */
  format: 'hls' | 'mp4'
  /** 这一集实际给的是哪一档清晰度。清晰度按钮上显示它 */
  quality?: Quality
  /** 这一集能选的清晰度，从高到低。少于两项时不显示清晰度按钮 */
  qualities?: Quality[]
  /** 片头的起止位置（秒）。没有就永远不出现「跳过片头」 */
  intro?: { start: number; end: number }
  /** 片尾开始的位置（秒）。没有就按整集时长算 */
  outro?: number
}

// ───────────────────────── 数据源 ─────────────────────────

/** 界面需要的全部读取操作。演示数据（mock）和真实接口各实现一份，界面不关心是哪一份 */
export interface DataSource {
  home(): Promise<HomeFeed>
  filters(type: MediaType): Promise<ChannelFilters>
  /** cursor 传上一页返回的 next；第一页不传 */
  channel(type: MediaType, query: ChannelQuery, cursor?: string): Promise<Page<MediaItem>>
  /** 找不到时抛错，界面显示「暂无内容」 */
  detail(id: string): Promise<MediaItem>
  /** 相关推荐，最多 14 部。可以是空数组（栏目不出现） */
  related(id: string): Promise<MediaItem[]>
  /** 按 id 批量取（收藏、历史用）。返回顺序与传入一致，取不到的直接略过 */
  byIds(ids: string[]): Promise<MediaItem[]>
  /** 搜索结果，按相关程度排序，一次给全（不分页） */
  search(q: string): Promise<MediaItem[]>
  /** 输入时的联想，最多 8 部 */
  suggest(q: string): Promise<MediaItem[]>
  /** 热搜词，最多 10 个 */
  hotSearches(): Promise<string[]>
  /** 取某一集的播放信息。quality 是用户想要的档位，没有这一档时由数据源给最接近的 */
  playback(id: string, episode: number, quality?: Quality): Promise<Playback>
}

// ───────────────────────── 本机状态 ─────────────────────────
// 收藏、历史、搜索记录、设置都存在本机（zustand persist），不经过数据源。

/** 一部片子只有一条历史：记录看到第几集的第几秒 */
export interface HistoryEntry {
  id: string
  /** 第几集，从 1 开始。单片固定为 1 */
  episode: number
  /** 看到的位置（秒） */
  position: number
  /** 这一集的总时长（秒） */
  duration: number
  /** 最后观看的时间（毫秒时间戳） */
  at: number
}

export interface Settings {
  /** 自动播放下一集 */
  autoNext: boolean
  /** 自动跳过片头片尾 */
  skipIntro: boolean
  /** 默认清晰度 */
  quality: Quality
  /** 默认倍速 */
  speed: Speed
  /** 音量 0–1 */
  volume: number
  muted: boolean
}

export interface UserState {
  /** 收藏的片子 id，新的在前 */
  favorites: string[]
  /** 观看历史，新的在前 */
  history: HistoryEntry[]
  /** 最近搜索，新的在前，最多 8 条 */
  searches: string[]
  settings: Settings
}
