// 展示规则：数据怎么变成界面上的字。全部是纯函数，直接用，不要自己再写一份。
// 返回 null 的意思是「这一项不显示」：不要渲染空元素，更不要补「暂无」。

import { EPISODE_RANGE_SIZE, FINISHED_RATIO, SKIP_EDGE_SECONDS, UPNEXT_SECONDS } from './constants'
import { fmt, t } from './copy'
import type { HistoryEntry, MediaItem, Playback, Settings } from './types'

type Progress = Pick<HistoryEntry, 'position' | 'duration'>

// ───────────────────────── 片子 ─────────────────────────

/** 多集内容（剧集、综艺、动漫…）。不是多集就是单片 */
export const isSeries = (it: MediaItem): boolean => Boolean(it.episodes)

type EpisodeList = Pick<MediaItem, 'episodes' | 'episodeNumbers'>

export function playableEpisodes(item: EpisodeList, from = 1, to = item.episodes ?? 1): number[] {
  return item.episodeNumbers?.filter(number => number >= from && number <= to)
    ?? Array.from({ length: Math.max(0, to - from + 1) }, (_, index) => from + index)
}

export function nextEpisode(item: EpisodeList, current: number): number | undefined {
  if (item.episodeNumbers) return item.episodeNumbers.find(number => number > current)
  return current < (item.episodes ?? 1) ? current + 1 : undefined
}

export function episodeToPlay(item: EpisodeList, preferred: number): number {
  if (item.episodeNumbers) return item.episodeNumbers.find(number => number >= preferred) ?? item.episodeNumbers.at(-1) ?? 1
  return Math.min(preferred, item.episodes ?? 1)
}


/** 评分：固定一位小数 */
export const scoreText = (it: MediaItem): string | null => (it.score ? it.score.toFixed(1) : null)

/** 状态：多集内容用数据里的 status，单片用片长（118分钟） */
export const statusText = (it: MediaItem): string | null =>
  it.status || (it.runtime ? fmt(t.status.minutes, { n: it.runtime }) : null)

/** 第12集 / 第5期 */
export const episodeLabel = (it: MediaItem, n: number): string => fmt(t.status.episode, { n, unit: it.unit ?? '集' })

/** 播放页顶部和「即将播放」上的集名：第5期 · 第一场雨和第一次争吵。单片返回 null */
export const episodeHeading = (it: MediaItem, n: number): string | null =>
  isSeries(it) ? [episodeLabel(it, n), it.episodeTitles?.[n - 1]].filter(Boolean).join(' · ') : null

/** 卡片第二行：一句话卖点；没有就用类型 */
export const cardSub = (it: MediaItem): string | null => it.tagline || it.genres.join(' / ') || null

/** 横版卡片、主推、搜索首条用的图：优先剧照，没有就用海报 */
export const wideImage = (it: MediaItem): string | null => it.backdrop ?? it.poster

/**
 * 信息行（评分 · 年份 · 地区 · 类型 · 状态）里除评分以外的各项，缺哪项就没有哪项。
 * 评分单独用 scoreText() 取，因为它的颜色不一样。
 * @param region 是否带地区（详情页、搜索首条带；卡片、主推不带）
 * @param genres 最多带几个类型（详情页 3 个，其余 2 个）
 */
export const metaParts = (it: MediaItem, { region = false, genres = 2 } = {}): string[] => {
  const parts: string[] = []
  if (it.year) parts.push(String(it.year))
  if (region && it.region) parts.push(it.region)
  if (it.genres.length) parts.push(it.genres.slice(0, genres).join(' / '))
  const status = statusText(it)
  if (status) parts.push(status)
  return parts
}

/** 榜单条目第二行：悬疑 · 2025 */
export const rankSub = (it: MediaItem): string | null => [it.genres[0], it.year].filter(Boolean).join(' · ') || null

/** 头像里的字：名字的第一个字 */
export const avatarText = (name: string): string => [...name][0] ?? ''

// ───────────────────────── 进度与历史 ─────────────────────────

/** 看完了：进度超过 95% */
export const isFinished = (h: Progress): boolean => h.duration > 0 && h.position / h.duration > FINISHED_RATIO

/** 「继续观看」里出现的条目：历史里还没看完的 */
export const continuing = (history: readonly HistoryEntry[]): HistoryEntry[] => history.filter((h) => !isFinished(h))

/** 进度条的百分比（0–100 的整数） */
export const progressPercent = (h: Progress): number =>
  h.duration > 0 ? Math.min(100, Math.max(0, Math.round((h.position / h.duration) * 100))) : 0

/** 继续观看卡片的第二行：第12集 · 剩余18分钟 */
export const progressText = (it: MediaItem, h: HistoryEntry): string => {
  const minutes = Math.max(1, Math.round((h.duration - h.position) / 60))
  const rest = isFinished(h) ? t.status.finished : fmt(t.status.remaining, { n: minutes })
  return isSeries(it) ? `${episodeLabel(it, h.episode)} · ${rest}` : rest
}

/** 详情页主按钮上的字：播放 / 继续播放 / 继续播放 第12集 */
export const playLabel = (it: MediaItem, h: HistoryEntry | undefined): string => {
  if (!h) return t.action.play
  if (isSeries(it)) return fmt(t.action.resumeEpisode, { n: episodeToPlay(it, h.episode), unit: it.unit ?? '集' })
  return isFinished(h) ? t.action.play : t.action.resume
}

/** 进入播放页时从第几秒开始：同一集且没看完就接着看，否则从头 */
export const resumePosition = (h: HistoryEntry | undefined, episode: number): number =>
  h && h.episode === episode && !isFinished(h) ? h.position : 0

/**
 * 保存进度时该写进历史的内容。
 * 看完一集且还有下一集：记成「下一集从头」，这样「继续观看」会指向下一集。
 */
export function historyRecord(id: string, episode: number, position: number, duration: number, next: number | boolean | undefined): Omit<HistoryEntry, 'at'> {
  const following = typeof next === 'boolean' ? (next ? episode + 1 : undefined) : next
  return following !== undefined && isFinished({ position, duration })
    ? { id, episode: following, position: 0, duration: 0 }
    : { id, episode, position: Math.floor(position), duration }
}


export interface HistoryGroup {
  label: string
  items: HistoryEntry[]
}

/** 历史页的分组：今天 / 昨天 / 更早。没有内容的组不返回 */
export const groupHistory = (history: readonly HistoryEntry[], now = Date.now()): HistoryGroup[] => {
  const day = 86_400_000
  const today = new Date(now).setHours(0, 0, 0, 0)
  return [
    { label: t.me.today, items: history.filter((h) => h.at >= today) },
    { label: t.me.yesterday, items: history.filter((h) => h.at < today && h.at >= today - day) },
    { label: t.me.earlier, items: history.filter((h) => h.at < today - day) },
  ].filter((g) => g.items.length > 0)
}

// ───────────────────────── 选集 ─────────────────────────

export interface EpisodeRange {
  from: number
  to: number
  /** 标签页上的字：1-50 */
  label: string
}

/** 选集分段：50 集一段。只有一段时不显示分段标签 */
export const episodeRanges = (count: number, numbers?: number[]): EpisodeRange[] => {
  const ranges: EpisodeRange[] = []
  for (let from = 1; from <= count; from += EPISODE_RANGE_SIZE) {
    const to = Math.min(count, from + EPISODE_RANGE_SIZE - 1)
    if (numbers && !numbers.some(number => number >= from && number <= to)) continue
    ranges.push({ from, to, label: fmt(t.status.range, { a: from, b: to }) })
  }
  return ranges
}

/** 默认停在哪一段：正在看的那一集所在的段，否则第一段 */
export const rangeOf = (ranges: readonly EpisodeRange[], episode: number | undefined): EpisodeRange | undefined =>
  ranges.find((r) => episode !== undefined && episode >= r.from && episode <= r.to) ?? ranges[0]

/** 选集格子的状态：当前这一集 / 已经看过的（当前集之前的）/ 普通 */
export const episodeState = (n: number, current: number | undefined): 'current' | 'watched' | 'default' =>
  current === undefined ? 'default' : n === current ? 'current' : n < current ? 'watched' : 'default'

// ───────────────────────── 播放 ─────────────────────────

/** 时间：05:07，超过一小时 1:02:03 */
export const clock = (seconds: number): string => {
  const sec = Number.isFinite(seconds) && seconds > 0 ? seconds : 0
  const pad = (n: number) => String(n).padStart(2, '0')
  const h = Math.floor(sec / 3600)
  const m = Math.floor(sec / 60) % 60
  const s = Math.floor(sec % 60)
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

/** 倍速的写法：0.75× / 1.0× / 2.0× */
export const speedLabel = (speed: number): string => fmt(t.player.times, { n: Number.isInteger(speed) ? speed.toFixed(1) : String(speed) })

/** 倍速按钮上的字：正常速度时显示「倍速」，否则显示当前倍速 */
export const speedButtonLabel = (speed: number): string => (speed === 1 ? t.player.speed : speedLabel(speed))

/** 音量图标：静音 / 小于一半 / 其余 */
export const volumeIcon = (volume: number, muted: boolean): 'volume-mute' | 'volume-low' | 'volume' => {
  const level = muted ? 0 : volume
  return level === 0 ? 'volume-mute' : level < 0.5 ? 'volume-low' : 'volume'
}

/** 这一集算「播完」的位置：开着自动跳过且有片尾信息时是片尾开始处，否则是整集结尾 */
export const endPosition = (playback: Pick<Playback, 'outro'>, duration: number, settings: Pick<Settings, 'skipIntro'>): number =>
  settings.skipIntro && playback.outro !== undefined && playback.outro < duration ? playback.outro : duration

/** 从头起播时的位置：开着自动跳过且片头从开头算起时，直接从片头结束处开始 */
export const startPosition = (playback: Pick<Playback, 'intro'>, settings: Pick<Settings, 'skipIntro'>): number =>
  settings.skipIntro && playback.intro && playback.intro.start <= 0 ? playback.intro.end : 0

/** 现在要不要显示「跳过片头」：没开自动跳过，且正处在片头中间 */
export const showSkipIntro = (position: number, playback: Pick<Playback, 'intro'>, settings: Pick<Settings, 'skipIntro'>): boolean =>
  !settings.skipIntro &&
  playback.intro !== undefined &&
  position >= playback.intro.start + SKIP_EDGE_SECONDS &&
  position < playback.intro.end - SKIP_EDGE_SECONDS

/**
 * 「即将播放」倒计时的秒数；不该显示时返回 null。
 * 显示条件：有下一集、开着自动播放下一集、用户没点取消、距离播完不到 10 秒。
 */
export const upNextSeconds = (position: number, end: number, opts: { hasNext: boolean; autoNext: boolean; cancelled: boolean }): number | null => {
  const left = end - position
  if (!opts.hasNext || !opts.autoNext || opts.cancelled || left <= 0 || left > UPNEXT_SECONDS) return null
  return Math.max(1, Math.ceil(left))
}
