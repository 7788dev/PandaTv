// 演示数据源：把 catalog.json 变成界面认识的 DataSource。
// 这里是纯逻辑，不依赖构建工具；应用里请用 index.ts 导出的 mockSource，不要直接用这个文件。
// 接入真实接口后，照着 DataSource 再实现一份即可，界面代码不用动。

import { DEFAULT_SETTINGS, HOT_SEARCH_MAX, QUALITIES, RELATED_MAX, SUGGEST_MAX } from '../contract/constants.ts'
import type {
  ChannelFilters,
  ChannelQuery,
  DataSource,
  HistoryEntry,
  HomeFeed,
  MediaItem,
  MediaType,
  Page,
  Playback,
  Shelf,
  UserState,
} from '../contract/types.ts'

type Board = { title: string; more?: string; items: string[] }
type RawShelf = { id: string; kind: Shelf['kind']; title?: string; more?: string; items?: string[]; boards?: Board[] }

/** catalog.json 的形状：首页和用户数据里只写片子的 id */
export interface Catalog {
  items: MediaItem[]
  home: { hero: string[]; shelves: RawShelf[] }
  user: {
    favorites: string[]
    history: (Omit<HistoryEntry, 'at'> & { daysAgo: number })[]
    searches: string[]
  }
  hotSearches: string[]
  channels: { type: MediaType; title: string }[]
  filters: Record<MediaType, ChannelFilters>
  sources: { hls: string; mp4: string }
}

export interface MockOptions {
  /** 把 catalog 里的图片路径（art/posters/x.webp）换成能放进 <img src> 的地址；换不出来返回 undefined */
  asset: (path: string) => string | undefined
  /** 模拟网络延迟（毫秒）。默认 0；调到 1500 左右可以看清骨架屏和加载状态 */
  delay?: number
  /** 频道页每页几条。默认 30（演示数据一页就到底）；调到 6 可以看分页加载 */
  pageSize?: number
  /** 让某个操作失败一次，用来看出错状态。例如 fail: (op) => op === 'detail' */
  fail?: (op: keyof DataSource) => boolean
}

/** 演示用的片头长度（秒）：剧集和动漫有片头 */
const INTRO_SECONDS = 90

export function createMockSource(catalog: Catalog, { asset, delay = 0, pageSize = 30, fail }: MockOptions): DataSource {
  const image = (path: string | null) => (path ? (asset(path) ?? null) : null)
  const items = catalog.items.map((it) => ({ ...it, poster: image(it.poster), backdrop: image(it.backdrop) }))
  const byId = new Map(items.map((it) => [it.id, it]))
  const pick = (ids: readonly string[]) => ids.flatMap((id) => byId.get(id) ?? [])
  const channelTitle = (type: MediaType) => catalog.channels.find((c) => c.type === type)?.title ?? ''

  /** 每个操作都经过这里：模拟延迟和失败 */
  const reply = async <T>(op: keyof DataSource, make: () => T): Promise<T> => {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
    if (fail?.(op)) throw new Error(`mock: ${op} failed`)
    return make()
  }

  /** 搜索：片名 > 原名 > 类型、频道名 > 导演、演员 */
  const find = (q: string): MediaItem[] => {
    const key = q.trim().toLowerCase()
    if (!key) return []
    const hit = (s: string | undefined) => Boolean(s?.toLowerCase().includes(key))
    const rank = (it: MediaItem) =>
      hit(it.title) ? 0
      : hit(it.originalTitle) ? 1
      : it.genres.some(hit) || hit(channelTitle(it.type)) ? 2
      : it.directors?.some(hit) || it.cast?.some((p) => hit(p.name)) ? 3
      : -1
    return items
      .map((it) => ({ it, rank: rank(it) }))
      .filter((r) => r.rank >= 0)
      .sort((a, b) => a.rank - b.rank)
      .map((r) => r.it)
  }

  const overlap = (a: MediaItem, b: MediaItem) => a.genres.filter((g) => b.genres.includes(g)).length

  return {
    home: () =>
      reply('home', (): HomeFeed => ({
        hero: pick(catalog.home.hero),
        shelves: catalog.home.shelves.map((s): Shelf => {
          if (s.kind === 'continue') return { id: s.id, kind: 'continue' }
          if (s.kind === 'rank')
            return { id: s.id, kind: 'rank', boards: (s.boards ?? []).map((b) => ({ ...b, items: pick(b.items) })) }
          return { id: s.id, kind: s.kind, title: s.title ?? '', ...(s.more ? { more: s.more } : {}), items: pick(s.items ?? []) }
        }),
      })),

    filters: (type) => reply('filters', () => catalog.filters[type]),

    channel: (type, query: ChannelQuery, cursor) =>
      reply('channel', (): Page<MediaItem> => {
        const numericYears = catalog.filters[type].years.filter((y) => /^\d+$/.test(y)).map(Number)
        const matchYear = (it: MediaItem) => {
          if (!query.year) return true
          if (it.year === undefined) return false
          // 「更早」：比列出来的年份都早
          return /^\d+$/.test(query.year) ? it.year === Number(query.year) : it.year < Math.min(...numericYears)
        }
        let rows = items.filter(
          (it) =>
            it.type === type &&
            (!query.genre || it.genres.includes(query.genre)) &&
            (!query.region || it.region === query.region) &&
            matchYear(it),
        )
        if (query.sort === 'new') rows = [...rows].sort((a, b) => (b.year ?? 0) - (a.year ?? 0))
        if (query.sort === 'score') rows = [...rows].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        const start = Number(cursor) || 0
        const end = start + pageSize
        return { items: rows.slice(start, end), next: end < rows.length ? String(end) : null }
      }),

    detail: (id) =>
      reply('detail', () => {
        const it = byId.get(id)
        if (!it) throw new Error(`mock: no item ${id}`)
        return it
      }),

    related: (id) =>
      reply('related', () => {
        const it = byId.get(id)
        if (!it) return []
        return items
          .filter((x) => x.id !== id && x.type === it.type)
          .sort((a, b) => overlap(b, it) - overlap(a, it))
          .slice(0, RELATED_MAX)
      }),

    byIds: (ids) => reply('byIds', () => pick(ids)),

    search: (q) => reply('search', () => find(q)),

    suggest: (q) => reply('suggest', () => find(q).slice(0, SUGGEST_MAX)),

    hotSearches: () => reply('hotSearches', () => catalog.hotSearches.slice(0, HOT_SEARCH_MAX)),

    // 演示流：多集内容用一段 10 分钟的 HLS，单片用一段 46 秒的 MP4（两种格式都能测到）。
    // 清晰度只是演示：切换后按钮上的字会变，画面不变。
    playback: (id, _episode, quality) =>
      reply('playback', (): Playback => {
        const it = byId.get(id)
        if (!it) throw new Error(`mock: no item ${id}`)
        const series = Boolean(it.episodes)
        return {
          url: series ? catalog.sources.hls : catalog.sources.mp4,
          format: series ? 'hls' : 'mp4',
          quality: quality ?? DEFAULT_SETTINGS.quality,
          qualities: [...QUALITIES],
          ...(it.type === 'tv' || it.type === 'anime' ? { intro: { start: 0, end: INTRO_SECONDS } } : {}),
        }
      }),
  }
}

/** 演示用的本机初始状态（收藏、历史、最近搜索），与设计稿和基准截图里的一致 */
export function createMockUser(catalog: Catalog, now = Date.now()): UserState {
  const day = 86_400_000
  return {
    favorites: [...catalog.user.favorites],
    history: catalog.user.history.map(({ daysAgo, ...h }) => ({ ...h, at: now - daysAgo * day })),
    searches: [...catalog.user.searches],
    settings: { ...DEFAULT_SETTINGS },
  }
}
