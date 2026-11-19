import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HomeFeed, MediaItem } from '../design/contract/types'
import { DoubanDataSource } from '../src/main/data/douban'
import type { DataWarning } from '../src/main/data/http'

const GENRE: Record<string, string> = { 电视剧: '剧情', 综艺: '真人秀', 动画: '动画', 纪录片: '纪录片' }
/** Douban as the home page asks it: every listing and collection answers three titles of `generation`. */
function upstream(generation: number, gate: Promise<void> | ((url: URL) => Promise<void>) = Promise.resolve()) {
  let calls = 0
  const fetch = (async (input: string | URL | Request) => {
    calls++
    const url = new URL(String(input))
    await (typeof gate === 'function' ? gate(url) : gate)
    const name = url.pathname.split('/').slice(-2).join('-') + (url.searchParams.get('tags') ?? '')
    const kind = url.pathname.includes('/movie/') || url.pathname.includes('movie_') ? 'movie' : 'tv'
    const genre = GENRE[url.searchParams.get('tags') ?? ''] ?? '剧情'
    let seed = 0
    for (const char of name) seed = (seed * 31 + char.charCodeAt(0)) % 100000
    const rows = [1, 2, 3].map(n => {
      const id = String(generation * 10000000 + seed * 10 + n)
      return { id, type: kind, title: `片 ${id}`, card_subtitle: `2024 / 中国大陆 / ${genre}`, rating: { value: 8 }, pic: { large: `https://img1.doubanio.com/view/photo/p${id}.jpg` } }
    })
    return new Response(JSON.stringify(url.pathname.includes('subject_collection') ? { subject_collection_items: rows } : { items: rows, count: 30, total: 3 }))
  }) as typeof globalThis.fetch
  return { fetch, calls: () => calls }
}
const offline = () => { let calls = 0; return { fetch: (async () => { calls++; throw new Error('offline') }) as typeof globalThis.fetch, calls: () => calls } }
const shelves = (feed: HomeFeed) => feed.shelves.map(shelf => shelf.id)
const ALL = ['continue', 'hot-tv', 'rank', 'new-movie', 'variety', 'anime', 'doc']
const isDoc = (url: URL) => url.searchParams.get('tags') === '纪录片'
const titles = (feed: HomeFeed) => feed.shelves.flatMap(shelf => shelf.kind === 'continue' ? [] : shelf.kind === 'rank' ? shelf.boards.flatMap(board => board.items) : shelf.items).map((item: MediaItem) => item.id)
const source = (cacheDir: string | undefined, net: { fetch: typeof globalThis.fetch }, extra: { onHome?: (feed: HomeFeed) => void; onWarning?: (warning: DataWarning) => void } = {}) =>
  new DoubanDataSource({ imageUrl: value => value, cacheDir, fetch: net.fetch, onWarning: () => {}, homeRetryMs: [0, 0], ...extra })
/** A run that read the home page and was closed. */
async function earlierRun() {
  const cacheDir = await mkdtemp(join(tmpdir(), 'panda-home-'))
  const first = source(cacheDir, upstream(1))
  await first.home()
  // The page is kept once every shelf has been read.
  await vi.waitFor(async () => { await readFile(join(cacheDir, 'home-v1.json'), 'utf8') }, { timeout: 10000 })
  const feed = await first.home()
  await first.flush()
  return { cacheDir, feed }
}
const later = (minutes: number) => vi.setSystemTime(Date.now() + minutes * 60000)

describe('home feed across runs', () => {
  afterEach(() => vi.useRealTimers())

  it('answers a new run from the saved feed, then hands over the feed read behind it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { cacheDir, feed } = await earlierRun()
    expect(feed.hero).toHaveLength(5)
    expect(shelves(feed)).toEqual(ALL)
    expect(titles(feed)).toHaveLength(30)
    later(30)
    let open = () => {}
    const net = upstream(2, new Promise<void>(resolve => { open = resolve }))
    const onHome = vi.fn<(feed: HomeFeed) => void>()
    const run = source(cacheDir, net, { onHome })
    // Douban has not answered anything yet: this is the saved feed, posters included.
    expect(await run.home()).toEqual(feed)
    expect(onHome).not.toHaveBeenCalled()
    open()
    await vi.waitFor(() => expect(onHome).toHaveBeenCalledTimes(1), { timeout: 10000 })
    const fresh = onHome.mock.calls[0]![0]
    expect(titles(fresh)).toHaveLength(30)
    expect(titles(fresh).every(id => id.startsWith('db-2'))).toBe(true)
    const calls = net.calls()
    expect(calls).toBe(10)
    expect(await run.home()).toEqual(fresh)
    expect(net.calls()).toBe(calls)
  }, 30000)

  it('keeps the saved feed and says so when Douban cannot be reached', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { cacheDir, feed } = await earlierRun()
    later(30)
    const warnings: DataWarning[] = []
    const onHome = vi.fn()
    const run = source(cacheDir, offline(), { onHome, onWarning: warning => warnings.push(warning) })
    expect(await run.home()).toEqual(feed)
    await vi.waitFor(() => expect(warnings.filter(warning => warning.operation === 'home').map(warning => warning.code)).toEqual(['CACHED']), { timeout: 10000 })
    expect(onHome).not.toHaveBeenCalled()
  }, 30000)

  it('asks nothing within ten minutes of the last read and announces nothing when the new read is the same', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { cacheDir, feed } = await earlierRun()
    later(5)
    const soon = upstream(2)
    expect(await source(cacheDir, soon).home()).toEqual(feed)
    expect(soon.calls()).toBe(0)
    later(30)
    const same = upstream(1)
    const onHome = vi.fn()
    const run = source(cacheDir, same, { onHome })
    expect(await run.home()).toEqual(feed)
    await vi.waitFor(() => expect(same.calls()).toBe(10), { timeout: 10000 })
    await run.flush()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(onHome).not.toHaveBeenCalled()
  }, 30000)

  it('a first run, or a run whose saved feed is unusable, waits for Douban and fails when it cannot be reached', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'panda-home-'))
    await expect(source(empty, offline()).home()).rejects.toMatchObject({ code: 'NETWORK' })

    const { cacheDir } = await earlierRun()
    await writeFile(join(cacheDir, 'home-v1.json'), '{"version":1,"at":')
    await expect(source(cacheDir, offline()).home()).rejects.toMatchObject({ code: 'NETWORK' })

    // A saved feed naming titles the metadata store no longer holds is not shown half empty.
    const lists = Object.fromEntries(['tv', 'movies', 'variety', 'anime', 'doc', 'tvRank', 'movieRank', 'animeRank'].map(name => [name, ['db-1', 'db-2', 'db-3']]))
    await writeFile(join(cacheDir, 'home-v1.json'), JSON.stringify({ version: 1, at: Date.now(), lists }))
    const net = upstream(3)
    const feed = await source(cacheDir, net).home()
    expect(net.calls()).toBeGreaterThan(0)
    expect(titles(feed).every(id => id.startsWith('db-3'))).toBe(true)
  }, 30000)

  it('a first run shows the top of the page without waiting for a slow shelf, and adds the shelves in page order', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'panda-home-'))
    let open = () => {}
    const slow = new Promise<void>(resolve => { open = resolve })
    const pushed: string[][] = []
    const run = source(cacheDir, upstream(1, url => isDoc(url) ? slow : Promise.resolve()), { onHome: feed => pushed.push(shelves(feed)) })
    const top = await run.home()
    // Douban has not answered the documentary listing; the page is there without it.
    expect(top.hero).toHaveLength(5)
    expect(shelves(top).slice(0, 2)).toEqual(['continue', 'hot-tv'])
    expect(shelves(top)).not.toContain('doc')
    await vi.waitFor(() => expect(pushed.at(-1) ?? shelves(top)).toEqual(ALL.slice(0, 6)), { timeout: 10000 })
    // Asked again meanwhile (the page was left and reopened): what is there so far, no second read.
    expect(shelves(await run.home())).toEqual(ALL.slice(0, 6))
    await expect(readFile(join(cacheDir, 'home-v1.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    open()
    await vi.waitFor(() => expect(pushed.at(-1)).toEqual(ALL), { timeout: 10000 })
    // Each step only added shelves below the ones already shown.
    let before = shelves(top)
    for (const step of pushed) { expect(step.slice(0, before.length)).toEqual(before); before = step }
    await vi.waitFor(async () => { await readFile(join(cacheDir, 'home-v1.json'), 'utf8') })
    expect(shelves(await run.home())).toEqual(ALL)
  }, 30000)

  it('a first read that fails says so at once, and asking again right away reads anew', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'panda-home-'))
    const net = upstream(1)
    let online = false
    const line = (async (input: string | URL | Request) => { if (!online) throw new Error('offline'); return net.fetch(input) }) as typeof globalThis.fetch
    // Long pauses: a retry that waited for the failed read's shelves would not finish in time.
    const run = new DoubanDataSource({ imageUrl: value => value, cacheDir, fetch: line, onWarning: () => {}, homeRetryMs: [60000, 60000] })
    const started = Date.now()
    await expect(run.home()).rejects.toMatchObject({ code: 'NETWORK' })
    online = true
    const feed = await run.home()
    expect(feed.hero).toHaveLength(5)
    expect(Date.now() - started).toBeLessThan(8000)
    await vi.waitFor(async () => expect(shelves(await run.home())).toEqual(ALL), { timeout: 10000 })
  }, 30000)

  it('a shelf whose answer fails for a moment is read again and takes its place', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'panda-home-'))
    const net = upstream(1)
    let failures = 0
    // The documentary listing fails twice (the request and its own retry), then answers.
    const flaky = (async (input: string | URL | Request) => isDoc(new URL(String(input))) && failures++ < 2 ? new Response('busy', { status: 503 }) : net.fetch(input)) as typeof globalThis.fetch
    const warnings: DataWarning[] = []
    const pushed: string[][] = []
    const run = source(cacheDir, { fetch: flaky }, { onHome: feed => pushed.push(shelves(feed)), onWarning: warning => warnings.push(warning) })
    await run.home()
    await vi.waitFor(() => expect(pushed.at(-1)).toEqual(ALL), { timeout: 10000 })
    expect(failures).toBeGreaterThanOrEqual(2)
    expect(warnings.filter(warning => warning.operation.startsWith('home'))).toEqual([])
    await vi.waitFor(async () => { await readFile(join(cacheDir, 'home-v1.json'), 'utf8') })
  }, 30000)

  it('a shelf that cannot be read is left out and reported, and that page is not kept for the next run', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'panda-home-'))
    const net = upstream(1)
    const warnings: DataWarning[] = []
    const pushed: string[][] = []
    const broken = (async (input: string | URL | Request) => isDoc(new URL(String(input))) ? new Response('{}', { status: 404 }) : net.fetch(input)) as typeof globalThis.fetch
    const run = source(cacheDir, { fetch: broken }, { onHome: feed => pushed.push(shelves(feed)), onWarning: warning => warnings.push(warning) })
    const top = await run.home()
    await vi.waitFor(() => expect(warnings.map(warning => warning.operation)).toContain('home:doc'), { timeout: 10000 })
    expect(pushed.at(-1) ?? shelves(top)).toEqual(ALL.slice(0, 6))
    await run.flush()
    await expect(readFile(join(cacheDir, 'home-v1.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    // Asked again, the missing shelf is read again and the page completes.
    const whole = source(cacheDir, net)
    await whole.home()
    await vi.waitFor(async () => expect(shelves(await whole.home())).toEqual(ALL), { timeout: 10000 })
  }, 30000)
})
