import type { MediaItem, MediaType, Playback, Quality } from '../../../design/contract/types'
import type { Availability, PlaySources } from '../../shared/api'
import { getText, openPublic, readLimited, unreachableHere, WorkLimiter } from './network'
import { MediaProxy } from './proxy'
import { clearHead, pictureOf } from './picture'
import { loadSourceRules, type PlaySource, type SourceRules } from './sources'
import { extra } from '../../copy.extra'
import { compareDelivery, compareSourceOrder, playbackMargin, PLAYBACK_HEADROOM, type DeliveryScore, type SourceOrderScore } from './delivery'

interface RawVod { vod_id?: string | number; vod_name?: string; vod_year?: string | number; type_name?: string; vod_play_from?: string; vod_play_url?: string }
export interface Episode { title: string; url: string; format: 'hls' | 'mp4'; number?: number }
export interface Line { name: string; episodes: Episode[] }
interface Candidate {
  source: PlaySource; vodId: string; lines: Line[]; dubbed: boolean
  /** Identified on weaker evidence than title, year and category together. */
  weak: boolean
  /** Set when the record is the whole serial: how many episodes of it are this work. */
  run?: number
}
/** What the metadata source knows about a work beyond its card. */
export interface WorkHints {
  /** A one-part work (a film); its alternative cuts and dubs are not episodes. */
  single?: boolean
  /** Other names the metadata source lists for the work. */
  aliases?: string[]
  /** How many episodes the metadata source says the work has. */
  totalEpisodes?: number
}
interface Cached<T> { value: T; expires: number }
/** An episode reached on a source: see `probe`. */
interface Reached { playback: Playback; whole: Promise<void>; shown?: Quality; margin(): number | undefined; /** Bytes of the first segment so far. */ received(): number }
/** How long a source has to answer with the first bytes of an episode. */
const REACH_MS = 10_000
/** How long the first segment may take in all; it keeps downloading for the player after the choice. */
const FIRST_SEGMENT_MS = 25_000
/**
 * How long the first source to answer is held back for one that delivers a whole first segment.
 * The first bytes say a source is up; a whole segment says it is fast enough to watch.
 */
const FIRST_SEGMENT_GRACE_MS = 3_000
/**
 * How long a source whose picture is smaller than asked for is held back, once its first
 * segment is in, for one that shows a better picture. Sources differ by work: the one that is
 * 1080p for most titles carries a cinema recording of another (measured 2026-11-17).
 */
const BETTER_PICTURE_MS = 1_500
/**
 * How long a source holds one of the three places without delivering its first segment. A
 * segment is a megabyte or two: from a provider that suits the viewer's network it is in within
 * a second (measured 2026-11-17 from mainland China: 0.3 to 1.9 s).
 */
const TURN_MS = 2_500
/** How many sources may be downloading a first segment at once, the slow ones included. */
const LIVE_MAX = 8
/** How long a source that failed or was slow is asked after the others. */
const SET_BACK_MS = 10 * 60_000
/** How much of a first segment is read looking for the size of its picture; it sat in the first kilobyte of every one captured. */
const PICTURE_BYTES = 64 * 1024
/** How long a choice of source for an episode is reused: the detail page and the previous episode ask ahead. */
const RESOLVED_MS = 3 * 60_000
/** Failures that say nothing about the source carrying the episode: worth one more attempt. */
const TRANSIENT = /网络请求失败|请求已取消|片源响应超时|（5\d\d）|媒体分片不完整|媒体分片为空/
/** How long a source may keep failing before a search stops waiting on it for a verdict. */
const SOURCE_GONE_AFTER = 2 * 60000
// The bundled pool currently has nine enabled catalogues. Keep one slow catalogue from
// occupying a slot needed by the last fallback source; custom rule files may add a few more
// sources without serialising the tail of the pool behind the first batch.
const CATALOGUE_CONCURRENCY = 12
const SEARCH_GRACE_MS = 1_200

interface ServiceOptions { proxy: MediaProxy; rules?: SourceRules; requeryDelayMs?: number; /** How long the catalogues that have not answered are waited for once the work is found. */ searchGraceMs?: number; /** Overrides FIRST_SEGMENT_GRACE_MS. */ firstSegmentGraceMs?: number; /** Overrides BETTER_PICTURE_MS. */ betterPictureMs?: number; /** Overrides TURN_MS. */ turnMs?: number; /** Told why a source's catalogue could not be read; for the main-process log only. */ onSourceFailure?: (source: string, reason: string, ms: number) => void }

const LANGUAGE = /(?:国语版?|普通话版?|粤语版?|英语版?|日语版?|韩语版?|泰语版?|中字|双语|高清|完整版|未删减版)$/
const CJK_DIGIT: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
function ordinal(raw: string): number | undefined {
  if (/^\d{1,3}$/.test(raw)) return Number(raw)
  const match = /^(?:([一二两三四五六七八九])?十)?([一二两三四五六七八九])?$/.exec(raw)
  if (!match || !raw) return undefined
  const tens = raw.includes('十') ? (match[1] ? CJK_DIGIT[match[1]]! : 1) * 10 : 0
  return tens + (match[2] ? CJK_DIGIT[match[2]]! : 0) || undefined
}
/** Zero-width and direction marks: Douban titles sometimes end in one, and no catalogue stores it. */
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g
const squash = (raw: string) => raw.normalize('NFKC').toLowerCase().replace(INVISIBLE, '').replace(/[\s·・:：!！?？,，。.'"“”‘’《》【】\[\]（）()_\-—~△]/g, '')

export function normalizedTitle(raw: string): string { return squash(raw).replace(LANGUAGE, '') }

export interface TitleKey { base: string; season: number; dubbed: boolean }
/**
 * Identity of a title as catalogues write it. "X 第二季", "X第2季" and "X2" are the
 * same work; a first season is commonly written without any season marker.
 */
export function titleKey(raw: string): TitleKey {
  const flat = squash(raw)
  const plain = flat.replace(LANGUAGE, '')
  const season = /^(.+?)第([一二两三四五六七八九十\d]{1,3})季$/.exec(plain) ?? /^(.+?)season(\d{1,2})$/.exec(plain) ?? /^(.*\D)(\d{1,2})$/.exec(plain)
  const number = season ? ordinal(season[2]!) : undefined
  return season && number ? { base: season[1]!, season: number, dubbed: plain !== flat } : { base: plain, season: 1, dubbed: plain !== flat }
}

export function classifySourceType(raw: string): MediaType | undefined {
  if (/动漫|动画/.test(raw)) return 'anime'
  if (/纪录|记录/.test(raw)) return 'doc'
  if (/综艺|晚会|脱口秀|真人秀/.test(raw)) return 'variety'
  // Film categories are written "剧情片", "喜剧片": test the film suffix before "剧".
  if (/片$|电影/.test(raw)) return 'movie'
  if (/剧$|剧集|电视|连续剧|短剧/.test(raw)) return 'tv'
  return undefined
}

export interface EpisodeRange { name: string; first: number; last: number }
/**
 * Douban files each run of a long serial as a subject of its own and says which run in an
 * alias: "凡人修仙传 第177-228集", "吞噬星空131-156集", "仙逆 第077-128集". Play sources keep one
 * record for the whole serial, numbered from its first episode.
 */
export function episodeRange(alias: string): EpisodeRange | undefined {
  const match = /^(.+?)\s*第?\s*(\d{1,4})\s*[-—~至]\s*(\d{1,4})\s*[集话]$/.exec(alias.normalize('NFKC').trim())
  if (!match || match[1] === '第') return undefined
  const first = Number(match[2]), last = Number(match[3])
  return first >= 1 && last >= first ? { name: match[1]!.trim(), first, last } : undefined
}

/**
 * The episodes of a serial's line that belong to `range`, numbered from 1.
 * Catalogues file a few extras with a long serial ("90分钟结局", "第240集上", "导演剪辑版");
 * those say nothing about the entries that do carry a number, so they are skipped rather than
 * making the whole line unusable. A number listed twice is ambiguous and left out. A list
 * that is mostly something other than numbered episodes does not say which episode is which.
 */
export function runOf(line: Line, range: EpisodeRange): Line | undefined {
  const numbered = line.episodes.filter(episode => episode.number != null && episode.number >= 1)
  if (numbered.length < line.episodes.length * 0.9 || !numbered.length) return undefined
  if (Math.max(...numbered.map(episode => episode.number!)) > line.episodes.length * 3 + 10) return undefined
  const times = new Map<number, number>()
  for (const episode of numbered) times.set(episode.number!, (times.get(episode.number!) ?? 0) + 1)
  const episodes = numbered.filter(episode => times.get(episode.number!) === 1 && episode.number! >= range.first && episode.number! <= range.last)
    .map(episode => ({ ...episode, number: episode.number! - range.first + 1 }))
  return episodes.length ? { name: line.name, episodes } : undefined
}

const NOT_FEATURE = /预告|解说|花絮|幕后|速看|精彩片段/
/** Douban marks regional titles: "刺激1995(台)". */
const REGION_NOTE = /\s*[（(][^（()）]{1,8}[)）]$/
export interface RecordMatch {
  /** The record is the whole serial; the work is this run of its episodes. */
  range?: EpisodeRange
  /**
   * Weaker evidence than title, year and category together: the record is filed under an alias,
   * or its year is one off (Douban dates a work by its first screening, catalogues by its release).
   */
  weak?: boolean
}
/**
 * Whether a source record is the work, and which part of the record. A record is accepted by
 * its name together with its year and category; a name alone is never enough.
 */
export function matchRecord(item: MediaItem, raw: RawVod, hints: WorkHints = {}): RecordMatch | undefined {
  if (!raw.vod_name || NOT_FEATURE.test(raw.vod_name) || NOT_FEATURE.test(String(raw.type_name ?? ''))) return undefined
  const year = Number.parseInt(String(raw.vod_year ?? ''), 10)
  const type = classifySourceType(String(raw.type_name ?? ''))
  const plain = squash(raw.vod_name).replace(LANGUAGE, '')
  // Catalogues disambiguate remakes by appending the release year to the name.
  const keys = [raw.vod_name, ...(year > 1800 && plain.endsWith(String(year)) ? [plain.slice(0, -4)] : [])].map(titleKey).filter(key => key.base)
  const named = (title: string) => { const wanted = titleKey(title); return keys.some(key => key.base === wanted.base && key.season === wanted.season) }
  const aliases = hints.aliases ?? []

  const range = aliases.flatMap(alias => episodeRange(alias) ?? []).find(value => named(value.name))
  // A serial is the same kind of work as its runs and began no later than they did; a run that
  // opens the serial began in the same year.
  if (range && type === item.type && !(item.year && year && (range.first === 1 ? year !== item.year : year > item.year))) {
    // The alias places the run; aliases and episode counts both lag when a run is extended, so the longer one is taken.
    const last = Math.max(range.last, hints.totalEpisodes ? range.first + hints.totalEpisodes - 1 : 0)
    return { range: { ...range, last } }
  }

  if (named(item.title)) {
    if (item.year && year && item.year !== year) return Math.abs(item.year - year) === 1 && type === item.type ? { weak: true } : undefined
    if (type && type !== item.type) {
      // Catalogues file non-fiction inconsistently (a documentary under 综艺, 剧 or 片). With the
      // exact title and release year both confirmed, those shelves name the same work.
      const sameYear = Boolean(item.year && year && item.year === year)
      const shelves: Partial<Record<MediaType, MediaType[]>> = { doc: ['variety', 'tv', 'movie'], variety: ['doc'] }
      if (!sameYear || !shelves[item.type]?.includes(type)) return undefined
    }
    // Ambiguous same-name records without identifying year/type are not safe automatic choices.
    if (!type && !year) return undefined
    return {}
  }

  // An alias is a weaker name than the title, so both the year and the category must confirm it.
  const alias = aliases.some(value => !episodeRange(value) && named(value.replace(REGION_NOTE, '')))
  return alias && item.year && item.year === year && type === item.type ? { weak: true } : undefined
}
export function matchesItem(item: MediaItem, raw: RawVod, hints?: WorkHints): boolean { return Boolean(matchRecord(item, raw, hints)) }

/** Search terms from most to least inclusive; maccms `wd` is a contiguous substring match. */
export function searchTerms(title: string): string[] {
  // Kept verbatim (no width folding): catalogues store the original punctuation.
  const whole = title.replace(INVISIBLE, '').trim()
  const seasonless = whole.replace(/\s*(?:第[一二两三四五六七八九十\d]{1,3}季|season\s*\d{1,2}|(?<=\D)\d{1,2})$/i, '').trim()
  const chunks = seasonless.split(/[\s·・:：!！?？,，。'"“”‘’《》【】\[\]（）()_\-—~△]+/).filter(Boolean)
  const longest = chunks.reduce((best, chunk) => chunk.length > best.length ? chunk : best, '')
  const distinctive = /[\u3400-\u9fff]/.test(longest) ? longest.length >= 2 : longest.length >= 4
  return [...new Set([...(distinctive ? [longest] : []), seasonless, whole].filter(Boolean))]
}

/** Terms for a work: its title first, then the serial its run belongs to, then two of its Chinese aliases. */
export function workTerms(title: string, aliases: string[] = []): string[] {
  const serials = aliases.flatMap(alias => episodeRange(alias)?.name ?? [])
  const others = aliases.filter(alias => !episodeRange(alias) && /[\u3400-\u9fff]/.test(alias)).map(alias => alias.replace(REGION_NOTE, '')).slice(0, 2)
  return [...new Set([...searchTerms(title), ...serials.flatMap(searchTerms), ...others.map(alias => searchTerms(alias)[0]!).filter(Boolean)])]
}

export function parseLines(from: string, value: string): Line[] {
  const names = from.split('$$$')
  return value.split('$$$').flatMap((blob, index) => {
    const name = names[index] ?? `线路 ${index + 1}`
    if (/yun/i.test(name)) return []
    const episodes: Episode[] = []
    for (const entry of blob.split('#')) {
      const separator = entry.indexOf('$')
      const title = separator >= 0 ? entry.slice(0, separator).trim() : ''
      const raw = (separator >= 0 ? entry.slice(separator + 1) : entry).trim().replaceAll('&amp;', '&')
      let url: URL
      try { url = new URL(raw.startsWith('//') ? `https:${raw}` : raw) } catch { continue }
      if (!['https:', 'http:'].includes(url.protocol)) continue
      const format = /\.m3u8$/i.test(url.pathname) ? 'hls' : /\.mp4$/i.test(url.pathname) ? 'mp4' : undefined
      if (!format) continue
      if (title && /预告|花絮|特辑|解说/.test(title)) continue
      // "第40集完结" and "第30集已完结" are episodes 40 and 30; "第240集上" is half of one and stays unnumbered.
      const numberMatch = /^(?:第)?0*(\d+)(?:集|期|话|回)?(?:已?完结|大结局|完)?$/.exec(title) ?? /^(?:EP|E)0*(\d+)$/i.exec(title)
      episodes.push({ title, url: url.href, format, ...(numberMatch ? { number: Number(numberMatch[1]) } : {}) })
    }
    return episodes.length ? [{ name, episodes }] : []
  })
}

const COUNTER = /^(?:第)?\d{1,4}(?:集|期|话|回)?$|^(?:EP|E)\d+$/i
/**
 * Episode number → entry. Titles are trusted as numbers only when every entry is
 * numbered, unique and in a plausible range; dated variety issues ("20241019"),
 * mixed lists and unnamed entries are addressed by position instead.
 * `titled` marks a positional list whose every entry has a name of its own (dated issues,
 * named parts): such a list says what each position is. One that mixes counters with other
 * entries ("第12集", "特别篇01") is only an order.
 */
const numberingCache = new WeakMap<Line, { byNumber: Map<number, Episode>; numeric: boolean; titled: boolean; count: number }>()
export function numbering(line: Line) {
  const cached = numberingCache.get(line)
  if (cached) return cached
  const numbers = line.episodes.map(e => e.number)
  const numeric = numbers.every(n => n != null && n >= 1) && new Set(numbers).size === numbers.length && Math.max(...numbers as number[]) <= numbers.length * 3 + 10
  const byNumber = new Map(line.episodes.map((episode, index) => [numeric ? episode.number! : index + 1, episode]))
  const titles = line.episodes.map(e => e.title)
  const titled = !numeric && new Set(titles).size === titles.length && titles.every(title => title && !COUNTER.test(title))
  const result = { byNumber, numeric, titled, count: Math.max(0, ...byNumber.keys()) }
  numberingCache.set(line, result)
  return result
}

interface Issue { date?: string; rest: string }
const issueCache = new WeakMap<Line, Issue[]>()
/** What an issue of a show is called once the decoration is off: "第20251025期上" and "20251025(上)" are both 20251025 + 上. */
export function issueKey(title: string): Issue {
  const bare = title.replace(/[\s()（）[\]【】\-_.·:：]/g, '')
  const date = /(?:^|\D)(20\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01]))(?!\d)/.exec(bare)?.[1]
  return date ? { date, rest: bare.replace(date, '').replace(/^第?期/, '') } : { rest: bare }
}
function issues(line: Line): Issue[] {
  let known = issueCache.get(line)
  if (!known) { known = line.episodes.map(episode => issueKey(episode.title)); issueCache.set(line, known) }
  return known
}
/**
 * The entry of another positional line that is the same issue as `wanted` of the reference line.
 * Sources spell issues differently and list them in different orders, so position says nothing.
 * Two entries are the same issue only when what identifies them occurs once in each list:
 * the same date and name; the same date where one name contains the other ("送机篇", "送机篇第1期",
 * or no name at all); or the same name where only one of the lists dates its issues.
 * Anything ambiguous is no match: playing another issue is worse than trying one source fewer.
 */
export function sameIssue(wanted: Episode, reference: Line, other: Line): Episode | undefined {
  const index = reference.episodes.indexOf(wanted)
  if (index < 0) return undefined
  const mine = issues(reference), theirs = issues(other), key = mine[index]!
  const once = (list: Issue[], test: (issue: Issue) => boolean) => { const hits = list.flatMap((issue, at) => test(issue) ? [at] : []); return hits.length === 1 ? hits[0] : undefined }
  const pair = (test: (issue: Issue) => boolean) => once(mine, test) === index ? once(theirs, test) : undefined
  const named = key.rest.length >= 2
  let hit: number | undefined
  if (key.date || named) hit = pair(issue => issue.date === key.date && issue.rest === key.rest)
  if (hit === undefined && key.date) {
    hit = pair(issue => issue.date === key.date)
    if (hit !== undefined && !(theirs[hit]!.rest.includes(key.rest) || key.rest.includes(theirs[hit]!.rest))) hit = undefined
  }
  if (hit === undefined && named) {
    hit = pair(issue => issue.rest === key.rest)
    if (hit !== undefined && theirs[hit]!.date && key.date) hit = undefined
  }
  return hit === undefined ? undefined : other.episodes[hit]
}

const qualityFor = (width: number, height: number): Quality | undefined => width >= 3800 || height >= 2100 ? '4K' : width >= 1900 || height >= 1000 ? '1080P' : width >= 1200 || height >= 700 ? '720P' : width >= 600 || height >= 400 ? '480P' : undefined
const qualityRank: Record<Quality, number> = { '4K': 4, '1080P': 3, '720P': 2, '480P': 1 }

export function manifestVariants(text: string, base: URL): Array<{ url: string; quality?: Quality; bandwidth: number }> {
  const lines = text.split(/\r?\n/).map(l => l.trim())
  return lines.flatMap((line, index) => {
    if (!line.startsWith('#EXT-X-STREAM-INF:') || !lines[index + 1] || lines[index + 1]!.startsWith('#')) return []
    const size = /RESOLUTION=(\d+)x(\d+)/.exec(line)
    return [{ url: new URL(lines[index + 1]!, base).href, quality: size ? qualityFor(Number(size[1]), Number(size[2])) : undefined, bandwidth: Number(/(?:^|,)BANDWIDTH=(\d+)/.exec(line)?.[1] ?? 0) }]
  })
}

/**
 * The line every episode number refers to: the most complete one, best-ranked source first.
 * A list that is only an order (episodes with specials mixed in) counts its extras as episodes,
 * so it is the reference only when no line says which entry is which.
 */
export function referenceLine(lines: Line[]): Line | undefined {
  const reliable = lines.filter(line => numbering(line).numeric || numbering(line).titled)
  return (reliable.length ? reliable : lines).reduce<Line | undefined>((best, line) => !best || numbering(line).count > numbering(best).count ? line : best, undefined)
}

/** For the main-process log only: an error with the system error behind it. */
const reason = (error: unknown) => error instanceof Error ? [error.message, (error.cause as NodeJS.ErrnoException | undefined)?.code ?? (error.cause as Error | undefined)?.message].filter(Boolean).join(' / ') : String(error)

export class PlaybackService {
  private readonly rules: SourceRules
  private readonly cache = new Map<string, Cached<Candidate[]>>()
  private readonly inflight = new Map<string, Promise<Candidate[]>>()
  // Every catalogue is asked at once: with fewer slots than sources the slowest ones queue behind the rest.
  private readonly limiter = new WorkLimiter(CATALOGUE_CONCURRENCY)
  private readonly resolved = new Map<string, Cached<Promise<Playback>>>()
  /** Sources whose last request failed: how often in a row, since when, and until when they are left alone. */
  private readonly failures = new Map<string, { count: number; until: number; since: number }>()
  private readonly selected = new Map<string, string>()
  /** Work → the source its viewer asked for; the next episodes start there too. */
  private readonly preferred = new Map<string, string>()
  /** Work → the last source that won; used only to break a tie in the next episode's race. */
  private readonly winners = new Map<string, string>()
  /** Work + source → until when it is asked after the others: it failed or was slow for this work. */
  private readonly behind = new Map<string, number>()
  constructor(private readonly options: ServiceOptions) { this.rules = options.rules ?? loadSourceRules() }

  private primary(candidates: Candidate[]): Line | undefined { return referenceLine(candidates.flatMap(c => c.lines)) }

  async availability(item: MediaItem, hints: WorkHints = {}): Promise<Availability> {
    const single = hints.single ?? item.type === 'movie'
    const candidates = await this.candidates(item, hints)
    const line = this.primary(candidates)
    if (!line) throw new Error(extra.sourceUnavailable)
    const plan = numbering(line)
    if (single || plan.count <= 1) return {}
    // Numbered lines from different sources describe the same episodes, so the newest
    // episode any of them carries is playable. Positional lists are only comparable to themselves.
    const count = plan.numeric ? Math.max(...candidates.flatMap(c => c.lines).map(numbering).filter(value => value.numeric).map(value => value.count)) : plan.count
    // Real names only (dated issues, named parts); plain counters stay number cells.
    return { episodes: count, ...(plan.titled ? { episodeTitles: line.episodes.map(e => e.title) } : {}) }
  }

  /**
   * A playable address for an episode. The choice is reused for a few minutes, so asking ahead
   * (the detail page, the episode before) makes pressing play immediate; `retry` always chooses
   * anew, and so does `from`, which names the one source the viewer asked for.
   */
  async resolve(item: MediaItem, episode: number, quality?: Quality, retry = false, hints: WorkHints = {}, from?: string): Promise<Playback> {
    if (!Number.isInteger(episode) || episode < 1 || episode > 10000) throw new Error('集数无效')
    const key = [item.id, episode, quality ?? ''].join('|')
    const known = this.resolved.get(key)
    if (!retry && !from && known && known.expires > Date.now()) return known.value
    const task = this.choose(item, episode, quality, retry, hints, from)
    this.resolved.delete(key)
    if (this.resolved.size >= 64) this.resolved.delete(this.resolved.keys().next().value!)
    this.resolved.set(key, { value: task, expires: Date.now() + RESOLVED_MS })
    task.catch(() => { if (this.resolved.get(key)?.value === task) this.resolved.delete(key) })
    return task
  }

  /** The sources that carry an episode, best first, and the one it is playing from. */
  async sources(item: MediaItem, episode: number, hints: WorkHints = {}): Promise<PlaySources> {
    const attempts = await this.attempts(item, episode, hints)
    const list = [...new Map(attempts.map(attempt => [attempt.source.key, { key: attempt.source.key, name: attempt.source.name }])).values()]
    const current = this.selected.get(item.id + ':' + episode)
    return { list, ...(current && list.some(entry => entry.key === current) ? { current } : {}) }
  }

  /** Every line that lists the episode, in the order the sources rank. */
  private async attempts(item: MediaItem, episode: number, hints: WorkHints) {
    const single = hints.single ?? item.type === 'movie'
    const candidates = await this.candidates(item, hints)
    const primary = this.primary(candidates)
    const plan = primary && numbering(primary)
    const wanted = plan?.byNumber.get(episode)
    const attempts = candidates.flatMap(c => c.lines.flatMap(line => {
      const other = numbering(line)
      // A film is its first entry on any line. Otherwise numbered lines agree by number, and a
      // positional line is only interchangeable where it lists the same issue (see sameIssue).
      const target = single ? (episode === 1 ? line.episodes[0] : undefined)
        : plan?.numeric ? (other.numeric ? other.byNumber.get(episode) : undefined)
        : line === primary ? wanted : other.numeric || !wanted?.title ? undefined : other.byNumber.get(episode)?.title === wanted.title ? other.byNumber.get(episode) : sameIssue(wanted, primary!, line)
      return target ? [{ ...c, line, target }] : []
    }))
    if (!attempts.length) throw new Error(extra.noEpisode)
    return attempts
  }

  private async choose(item: MediaItem, episode: number, quality: Quality | undefined, retry: boolean, hints: WorkHints, from?: string): Promise<Playback> {
    const selectionKey = item.id + ':' + episode
    const previous = this.selected.get(selectionKey)
    // The player asks again when what it was given did not play.
    if (retry && previous) this.setBack(item.id, previous)
    const back = (key: string) => Number((this.behind.get(this.behindKey(item.id, key)) ?? 0) > Date.now())
    const winner = this.winners.get(item.id)
    const attempts = (await this.attempts(item, episode, hints)).sort((a, b) => {
      const score = (attempt: typeof a): SourceOrderScore => ({
        behind: Boolean(back(attempt.source.key)),
        previous: attempt.source.key === previous,
        winner: attempt.source.key === winner,
      })
      return compareSourceOrder(score(a), score(b), retry)
    })
    // A user retry starts with another provider, rather than replaying a broken URL.
    const alternatives = retry && previous ? attempts.filter(attempt => attempt.source.key !== previous) : attempts
    const ordered = alternatives.length ? alternatives : attempts
    // The source the viewer asked for is not raced against the others: it plays if it can.
    const asked = from ?? (retry ? undefined : this.preferred.get(item.id))
    const own = asked ? attempts.filter(attempt => attempt.source.key === asked) : []
    if (from && !own.length) throw new Error(extra.noEpisode)
    const rest = from ? [] : ordered.filter(attempt => !own.includes(attempt))
    const failed = new Map<typeof attempts[number], unknown>()
    // The picture that is enough: the one asked for, and nothing waits for more than 1080P.
    const enough = Math.min(qualityRank[quality ?? '1080P'], qualityRank['1080P'])
    // A picture that could not be read ranks between 480P and 720P: it does not win outright,
    // and it does not lose to one known to be small.
    const worth = (shown: Quality | undefined) => shown ? Math.min(qualityRank[shown], enough) : 1.5
    // Three sources are asked at a time. The next one starts the moment one drops out, or has
    // had its turn without delivering: one slow or dead provider cannot hold up another
    // provider's first picture, and which providers are slow depends on where the viewer is.
    const contest = (list: typeof attempts) => new Promise<Playback>((resolve, reject) => {
      const grace = this.options.firstSegmentGraceMs ?? FIRST_SEGMENT_GRACE_MS
      const turn = this.options.turnMs ?? TURN_MS
      const live = new Map<typeof list[number], { controller: AbortController; started: number; reached?: Reached }>()
      /** Sources whose first segment is in but whose picture is smaller than asked for, in the order they came in. */
      const held: Array<{ attempt: typeof list[number]; playback: Playback; score: DeliveryScore }> = []
      const timers = new Set<ReturnType<typeof setTimeout>>()
      let next = 0, over = false, settling = false, waiting = false
      const later = (work: () => void, ms: number) => {
        const timer = setTimeout(() => { timers.delete(timer); if (!over) work() }, ms)
        timers.add(timer)
      }
      const stop = (keep?: typeof list[number]) => {
        over = true
        for (const timer of timers) clearTimeout(timer)
        for (const [attempt, entry] of live) {
          // A full turn without a whole segment: slow from here, whatever it is elsewhere.
          if (Date.now() - entry.started >= turn) this.setBack(item.id, attempt.source.key)
          if (attempt !== keep) entry.controller.abort()
        }
      }
      // A source wins by delivering its whole first segment with the picture asked for. One
      // with a smaller picture gives up its place to the next source and wins when nothing
      // better has come in a moment later.
      const win = (attempt: typeof list[number], playback: Playback) => {
        if (over) return
        stop(attempt)
        if (this.selected.size > 512) this.selected.delete(this.selected.keys().next().value!)
        this.selected.set(selectionKey, attempt.source.key)
        if (this.winners.size > 256) this.winners.delete(this.winners.keys().next().value!)
        this.winners.set(item.id, attempt.source.key)
        if (from) {
          if (this.preferred.size > 256) this.preferred.delete(this.preferred.keys().next().value!)
          this.preferred.set(item.id, from)
        }
        resolve(playback)
      }
      /** The best picture among those held; the earliest of equals. */
      const settleNow = () => { const best = held.reduce((a, b) => compareDelivery(b.score, a.score) > 0 ? b : a); win(best.attempt, best.playback) }
      // A picture below 720P is visibly poor: while another source's segment is on its way in,
      // it is given the same moment once more.
      let extended = false
      const settle = () => {
        const poor = held.every(entry => entry.score.picture < qualityRank['720P'])
        if (poor && !extended && [...live.values()].some(entry => entry.reached)) { extended = true; later(settleNow, this.options.betterPictureMs ?? BETTER_PICTURE_MS); return }
        settleNow()
      }
      const delivered = (attempt: typeof list[number], reached: Reached) => {
        if (over) return
        const margin = reached.margin()
        if (margin !== undefined && margin < PLAYBACK_HEADROOM) this.setBack(item.id, attempt.source.key)
        else this.behind.delete(this.behindKey(item.id, attempt.source.key))
        const value = worth(reached.shown)
        if (value >= enough && margin !== undefined && margin >= PLAYBACK_HEADROOM) return win(attempt, reached.playback)
        live.delete(attempt)
        held.push({ attempt, playback: reached.playback, score: { picture: value, margin } })
        if (!settling) { settling = true; later(settle, this.options.betterPictureMs ?? BETTER_PICTURE_MS) }
        start()
        if (!live.size) settleNow()
      }
      const lose = (attempt: typeof list[number], error: unknown) => {
        live.delete(attempt)
        if (over) return
        this.setBack(item.id, attempt.source.key)
        failed.set(attempt, error)
        start()
        if (live.size) return
        if (held.length) settleNow(); else { stop(); reject(new Error('片源暂时无法连接，请重试')) }
      }
      // When none has delivered a segment by the time the last one to start has had as long as
      // the first, the one whose download is coming in fastest plays.
      const patient = () => {
        waiting = false
        if (!live.size) return
        const wait = Math.max(...[...live.values()].map(entry => entry.started)) + grace - Date.now()
        if (wait > 0) { waiting = true; later(patient, wait); return }
        // One that delivered is waiting for a better picture; that wait ends by itself.
        if (held.length) return
        const answered = [...live].filter(([, entry]) => entry.reached)
        // Nobody has answered yet; each gives up on its own (REACH_MS).
        if (!answered.length) { waiting = true; later(patient, 100); return }
        const score = (entry: { reached?: Reached }): DeliveryScore => ({ picture: worth(entry.reached!.shown), margin: entry.reached!.margin() })
        const rate = (entry: { started: number; reached?: Reached }) => entry.reached!.received() / Math.max(1, Date.now() - entry.started)
        const [attempt, entry] = answered.reduce((a, b) => { const compared = compareDelivery(score(b[1]), score(a[1])); return (compared > 0 || (compared === 0 && rate(b[1]) > rate(a[1]))) ? b : a })
        const margin = entry.reached!.margin()
        if (margin !== undefined && margin < PLAYBACK_HEADROOM) this.setBack(item.id, attempt.source.key)
        win(attempt, entry.reached!.playback)
      }
      const start = () => {
        if (over) return
        const fresh = () => [...live.values()].filter(entry => Date.now() - entry.started < turn).length
        while (next < list.length && fresh() < 3 && live.size < LIVE_MAX) {
          const attempt = list[next++]!, asked = Date.now()
          const entry: { controller: AbortController; started: number; reached?: Reached } = { controller: new AbortController(), started: asked }
          live.set(attempt, entry)
          // After its turn it keeps downloading, and no longer holds back the next source.
          later(start, turn + 5)
          this.probe(attempt.target, attempt.source, quality, entry.controller.signal).then(reached => {
            if (over) return
            entry.reached = reached
            reached.whole.then(() => delivered(attempt, reached), error => lose(attempt, error))
          }, error => {
            if (!over) this.options.onSourceFailure?.(attempt.source.key, 'probe: ' + reason(error), Date.now() - asked)
            lose(attempt, error)
          })
        }
        if (!waiting && live.size) { waiting = true; later(patient, grace) }
      }
      start()
      if (!live.size) reject(new Error('片源暂时无法连接，请重试'))
    })
    for (const list of [own, rest]) if (list.length) { try { return await contest(list) } catch { /* asked again below where that can help */ } }
    // A reset connection or a deadline says nothing about the episode. Before telling the viewer
    // that it cannot be played, ask once more those that failed that way.
    const again = [...own, ...rest].filter(attempt => TRANSIENT.test(reason(failed.get(attempt)))).slice(0, 3)
    if (again.length) { try { return await contest(again) } catch { /* reported below */ } }
    throw new Error('片源暂时无法连接，请重试')
  }

  /** A source that failed or was slow just now is asked after the others for this work. */
  private setBack(itemId: string, source: string) {
    const now = Date.now()
    if (this.behind.size >= 1024) {
      for (const [key, until] of this.behind) if (until <= now) this.behind.delete(key)
      if (this.behind.size >= 1024) this.behind.delete(this.behind.keys().next().value!)
    }
    this.behind.set(this.behindKey(itemId, source), now + SET_BACK_MS)
  }
  private behindKey(itemId: string, source: string) { return `${itemId}:${source}` }

  /**
   * Reaches an episode on one source. Resolves when the start of its first segment has arrived
   * and the size of its picture has been read from it (`shown`; undefined when it cannot be
   * read); `whole` settles when that segment has been read to the end. What was read — the
   * playlists, the key and that segment — is handed to the proxy, so the player's first
   * requests are answered from memory instead of being sent to the source a second time.
   */
  private async probe(episode: Episode, source: PlaySource, quality: Quality | undefined, cancel: AbortSignal): Promise<Reached> {
    const own = new AbortController()
    const reach = AbortSignal.any([cancel, own.signal, AbortSignal.timeout(REACH_MS)])
    const body = AbortSignal.any([cancel, own.signal, AbortSignal.timeout(FIRST_SEGMENT_MS)])
    const within = <T>(work: Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => {
      const late = () => reject(new Error('片源响应超时'))
      if (reach.aborted) return late()
      reach.addEventListener('abort', late, { once: true })
      work.then(resolve, reject).finally(() => reach.removeEventListener('abort', late))
    })
    try {
      if (episode.format === 'mp4') {
        const { response } = await openPublic(episode.url, { headers: { Range: 'bytes=0-16383' }, signal: reach })
        if (![200, 206].includes(response.statusCode ?? 0) || /text\/html/.test(String(response.headers['content-type']))) { response.destroy(); throw new Error('媒体不可用') }
        response.destroy()
        return { playback: { url: this.options.proxy.registerMedia(episode.url, source), format: 'mp4' }, whole: Promise.resolve(), margin: () => undefined, received: () => 0 }
      }
      let current = episode.url; let selected: Quality | undefined; let qualities: Quality[] | undefined; let preserveTimeline = false
      for (let depth = 0; depth < 4; depth++) {
        const { text, url } = await getText(current, { signal: reach }, 4 * 1024 * 1024)
        if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('播放清单无效')
        if (/#EXT-X-MEDIA:.*TYPE=(?:AUDIO|SUBTITLES)/.test(text)) preserveTimeline = true
        const variants = manifestVariants(text, url)
        // A playlist that is complete will read the same when the player asks for it; a live one will not.
        if (variants.length || /#EXT-X-ENDLIST/.test(text)) this.options.proxy.warm(current, url, Buffer.from(text), 'application/vnd.apple.mpegurl')
        if (variants.length) {
          qualities = [...new Set(variants.flatMap(v => v.quality ? [v.quality] : []))].sort((a, b) => qualityRank[b] - qualityRank[a])
          const desired = qualityRank[quality ?? '1080P']
          const variant = variants.sort((a, b) => Math.abs((a.quality ? qualityRank[a.quality] : desired) - desired) - Math.abs((b.quality ? qualityRank[b.quality] : desired) - desired) || b.bandwidth - a.bandwidth)[0]!
          selected = variant.quality; current = variant.url; continue
        }
        // The segment the player will ask for first: the first one left after ad removal.
        const first = /#EXTINF:/.test(text) ? this.options.proxy.firstSegment(text, url, source, preserveTimeline) : undefined
        if (!first) throw new Error('播放清单没有媒体分片')
        const segment = first.url
        // Nothing plays without the key, so a source that cannot hand it over has not been reached.
        const secret = first.cipher ? within(this.key(first.cipher.key, reach)) : undefined
        secret?.catch(() => {})
        const segmentStarted = Date.now()
        const { response } = await within(openPublic(segment, { signal: body }))
        if (response.statusCode !== 200 || /text\/html/.test(String(response.headers['content-type']))) { response.destroy(); throw new Error(`媒体分片不可用（${response.statusCode}）`) }
        // Need at least actual bytes, not merely a successful HTTP response.
        const chunks = response[Symbol.asyncIterator]() as AsyncIterator<Buffer>
        const opening = await within(chunks.next())
        if (opening.done || !opening.value.length) { response.destroy(); throw new Error('媒体分片为空') }
        const declared = response.headers['content-encoding'] ? NaN : Number(response.headers['content-length'])
        const shared = this.options.proxy.share(segment, String(response.headers['content-type'] ?? ''), declared > 0 ? declared : undefined)
        shared.write(opening.value)
        let size = opening.value.length, ended = false, complete = false, measuredUntil: number | undefined
        let shown: Quality | undefined
        try {
          // What the segment holds, rather than what its playlist says about it.
          const key = await secret
          const head = [opening.value]
          const clear = () => { const bytes = Buffer.concat(head); return first.cipher ? clearHead(bytes, key!, first.cipher.iv) : bytes }
          let start = first.sealed ? undefined : clear()
          let picture = start && pictureOf(start)
          // Only a transport stream is read further, and not far: a slow source is not kept
          // waiting for something its segment may not hold.
          while (!picture && start && (start.length < 188 || start[0] === 0x47) && size < PICTURE_BYTES) {
            const next = await within(chunks.next())
            if (next.done) { ended = true; break }
            size += next.value.length; head.push(next.value); shared.write(next.value)
            start = clear(); picture = pictureOf(start)
          }
          shown = picture && qualityFor(picture.width, picture.height)
        } catch (error) { response.destroy(); shared.fail(); throw error }
        const whole = (async () => {
          try {
            for (let next = ended ? { done: true as const, value: undefined } : await chunks.next(); !next.done; next = await chunks.next()) {
              size += next.value.length
              // Too large to keep and nobody reading along: it has shown its speed.
              if (!shared.write(next.value)) { measuredUntil = Date.now(); response.destroy(); return }
            }
            if (declared > 0 && declared !== size) throw new Error('媒体分片不完整')
            complete = true; measuredUntil = Date.now()
            shared.end()
          } catch (error) { shared.fail(); throw error }
        })()
        whole.catch(() => {})
        // Multi-track manifests retain their master so HLS.js sees synchronized audio/subtitles.
        const target = preserveTimeline ? episode.url : current
        // Where the source offers several pictures the viewer chooses among them by their names;
        // where it offers one, its name is the picture that was read.
        const several = Boolean(qualities && qualities.length > 1)
        const label = several ? selected : shown ?? selected
        return { playback: { url: this.options.proxy.registerMedia(target, source, preserveTimeline), format: 'hls', ...(!preserveTimeline && label ? { quality: label } : {}), ...(!preserveTimeline && several ? { qualities } : {}) }, whole, shown: shown ?? selected, margin: () => playbackMargin(first.seconds, declared > 0 ? declared : undefined, size, (measuredUntil ?? Date.now()) - segmentStarted, complete), received: () => size }
      }
      throw new Error('播放清单嵌套过深')
    } catch (error) { own.abort(); throw error }
  }

  /** The key of an AES-128 playlist, kept for the player's own request for it. */
  private async key(address: URL, signal: AbortSignal): Promise<Buffer> {
    const { response, url } = await openPublic(address, { signal })
    if (response.statusCode !== 200) { response.destroy(); throw new Error(`播放密钥不可用（${response.statusCode}）`) }
    const key = await readLimited(response, 4096)
    if (key.length !== 16) throw new Error('播放密钥无效')
    this.options.proxy.warm(address.href, url, key, String(response.headers['content-type'] ?? 'application/octet-stream'))
    return key
  }

  private async candidates(item: MediaItem, hints: WorkHints): Promise<Candidate[]> {
    const key = [item.id, item.title, item.year ?? '', item.type, hints.totalEpisodes ?? '', ...(hints.aliases ?? [])].join('|')
    const cached = this.cache.get(key)
    if (cached && cached.expires > Date.now()) return cached.value
    const active = this.inflight.get(key); if (active) return active
    const keep = (value: Candidate[]) => {
      if (this.cache.size >= 128 && !this.cache.has(key)) this.cache.delete(this.cache.keys().next().value!)
      this.cache.set(key, { value, expires: Date.now() + (value.length ? 5 * 60000 : 20000) }); return value
    }
    const task = this.searchCandidates(item, hints, keep).then(keep).finally(() => this.inflight.delete(key))
    this.inflight.set(key, task); return task
  }

  /**
   * The records of the work in every catalogue. Catalogues answer in a few hundred milliseconds
   * as a rule, and now and then one takes its whole nine seconds (measured from Beijing,
   * 2026-11-17 14:17: one of nine did so for a third of the titles). Once the work has been
   * found, the rest get SEARCH_GRACE_MS more; what they answer after that goes to `late`.
   */
  private async searchCandidates(item: MediaItem, hints: WorkHints, late: (value: Candidate[]) => void = () => {}): Promise<Candidate[]> {
    let successes = 0
    const enabled = this.rules.sources.filter(s => s.enabled).sort((a, b) => b.priority - a.priority)
    const ask = (source: (typeof enabled)[number]) => this.limiter.run(async () => {
      const circuit = this.failures.get(source.key)
      if (circuit && circuit.until > Date.now()) throw new Error('片源冷却中')
      const signal = AbortSignal.timeout(9000)
      const asked = Date.now()
      try {
        const found: Candidate[] = []
        const seen = new Set<string>()
        search: for (const term of workTerms(item.title, hints.aliases)) {
          for (let page = 1; page <= 2; page++) {
            const url = new URL(source.api); url.searchParams.set('ac', 'videolist'); url.searchParams.set('wd', term); url.searchParams.set('pg', String(page))
            const payload = JSON.parse((await getText(url, { signal })).text) as { list?: RawVod[]; pagecount?: number }
            if (!Array.isArray(payload.list)) throw new Error('片源数据格式无效')
            successes++
            for (const raw of payload.list.filter(row => matchRecord(item, row, hints)).slice(0, 4)) {
              if (raw.vod_id == null || seen.has(String(raw.vod_id))) continue
              const id = String(raw.vod_id); seen.add(id)
              // List rows of some sources omit play URLs; the record itself is authoritative.
              let exact: RawVod | undefined = raw.vod_play_url ? raw : undefined
              if (!exact) {
                const detailUrl = new URL(source.api); detailUrl.searchParams.set('ac', 'videolist'); detailUrl.searchParams.set('ids', id)
                const detail = JSON.parse((await getText(detailUrl, { signal })).text) as { list?: RawVod[] }
                exact = detail.list?.find(row => String(row.vod_id) === id)
              }
              const match = exact && matchRecord(item, exact, hints)
              if (!exact || !match) continue
              const { range } = match
              const lines = parseLines(String(exact.vod_play_from ?? ''), String(exact.vod_play_url ?? '')).flatMap(line => range ? runOf(line, range) ?? [] : line)
              if (lines.length) found.push({ source, vodId: id, lines, dubbed: titleKey(String(exact.vod_name)).dubbed, weak: Boolean(match.weak), ...(range ? { run: range.last - range.first + 1 } : {}) })
            }
            if (found.length) break search
            if (page >= Number(payload.pagecount ?? 1)) break
          }
        }
        this.failures.delete(source.key)
        return found
      } catch (error) {
        const before = this.failures.get(source.key)
        const count = (before?.count ?? 0) + 1
        // A source this network cannot reach has been gone all along: it is not waited for.
        this.failures.set(source.key, { count, until: count >= 3 ? Date.now() + 30000 : 0, since: unreachableHere(error) ? 0 : before?.since ?? Date.now() })
        this.options.onSourceFailure?.(source.key, 'search: ' + reason(error), Date.now() - asked)
        throw error
      }
    })
    const query = (sources: typeof enabled) => Promise.allSettled(sources.map(ask))
    const asks = enabled.map(ask)
    const everyone = Promise.allSettled(asks)
    const flat = (results: PromiseSettledResult<Candidate[]>[]) => results.flatMap(result => result.status === 'fulfilled' ? result.value : [])
    const head = await new Promise<Candidate[] | undefined>(resolve => {
      const got: Candidate[] = []
      let timer: ReturnType<typeof setTimeout> | undefined
      // A catalogue whose last search failed is not waited for at all once the work is found.
      const awaited = new Set(enabled.filter(source => !this.failures.has(source.key)).map(source => source.key))
      asks.forEach((answer, i) => answer.then(value => {
        awaited.delete(enabled[i]!.key)
        if (value.length) {
          got.push(...value)
          timer ??= setTimeout(() => resolve([...got]), this.options.searchGraceMs ?? SEARCH_GRACE_MS)
        }
        if (got.length && !awaited.size) resolve([...got])
      }, () => { awaited.delete(enabled[i]!.key); if (got.length && !awaited.size) resolve([...got]) }))
      void everyone.then(() => { clearTimeout(timer); resolve(undefined) })
    })
    if (head) {
      void everyone.then(results => { const full = flat(results); if (full.length > head.length) late(rank(full)) })
      return rank(head)
    }
    const results = await everyone
    let found = flat(results)
    // A work only one catalogue carries is lost when that catalogue stumbles once. Before
    // reporting that nothing carries it, ask again the ones that failed just now; a source
    // that keeps failing is cooling down and is left alone.
    const stumbled = enabled.filter((source, i) => { const failure = this.failures.get(source.key); return results[i]!.status === 'rejected' && (failure?.count ?? 0) < 3 && failure?.since !== 0 })
    // The sources that did not answer this search, whatever they did for another work.
    let silent = enabled.filter((_, i) => results[i]!.status === 'rejected')
    if (!found.length && stumbled.length) {
      await new Promise(resolve => setTimeout(resolve, this.options.requeryDelayMs ?? 1000))
      const again = await query(stumbled)
      found = flat(again)
      silent = silent.filter(source => { const at = stumbled.indexOf(source); return at < 0 || again[at]!.status === 'rejected' })
    }
    if (!found.length && !successes) throw new Error(extra.unavailable)
    // "Not carried" is only true of the sources that answered. One that stopped answering a
    // moment ago may carry the work; one that has been failing for minutes is counted as gone.
    // Thrown rather than returned, so the next request asks again instead of reading a cache.
    const unanswered = silent.some(source => { const failure = this.failures.get(source.key); return failure && Date.now() - failure.since < SOURCE_GONE_AFTER })
    if (!found.length && unanswered) throw new Error(extra.unavailable)
    return rank(found)
  }
}

/**
 * The records that describe one work consistently, best first.
 * Exported for tests.
 */
export function rank<T extends { lines: Line[]; dubbed: boolean; weak: boolean; run?: number; source: { priority: number } }>(found: T[]): T[] {
  // Where the work was found as a run of its serial, the metadata source has said which
  // episodes it is. A record under the work's own title can list more (catalogues file the
  // next run with it), so it is cut to the same extent; a list without numbers cannot be compared.
  const run = Math.max(0, ...found.map(candidate => candidate.run ?? 0))
  const aligned = !run ? found : found.flatMap(candidate => {
    if (candidate.run) return candidate
    const lines = candidate.lines.flatMap(line => runOf(line, { name: '', first: 1, last: run }) ?? [])
    return lines.length ? { ...candidate, lines } : []
  })
  // A weakly identified record can be another cut of the work (an arc of the run under an alias)
  // or, rarely, another work of the same name, so it only stands in when nothing else was found.
  const candidates = aligned.some(candidate => !candidate.weak) ? aligned.filter(candidate => !candidate.weak) : aligned
  // Records named exactly like the work outrank alternative-language dubs of it.
  return candidates.sort((a, b) => Number(a.dubbed) - Number(b.dubbed) || b.source.priority - a.source.priority)
}
