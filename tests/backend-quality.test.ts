import { expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { DoubanHttp, DataError } from '../src/main/data/http'
import { DoubanDataSource } from '../src/main/data/douban'
import { WorkLimiter, isPublicAddress, validatePublicUrl } from '../src/main/playback/network'
import { filterPlaylist } from '../src/main/playback/filter'
import { loadSourceRules } from '../src/main/playback/sources'
import { initialQuery, suggestedSubjectIds, titleSearchScore, type InitialsDictionary } from '../src/shared/title-search'

const endpoint = 'https://m.douban.com/rexxar/api/v2/movie/41'
it('keeps the first usable TV shelf when the new-movie collection is missing on a cold start', async () => {
  const item = { id: '41', title: '浮生', type: 'tv', genres: ['剧情'], cover_url: 'https://img1.doubanio.com/view/41.jpg' }
  const source = new DoubanDataSource({ imageUrl: url => url, homeRetryMs: [], fetch: async input => {
    if (String(input).includes('/movie_latest/')) return new Response('{}', { status: 404 })
    return Response.json({ total: 1, count: 1, items: [item], subject_collection_items: [item] })
  } })
  const feed = await source.home()
  expect(feed.hero.map(item => item.id)).toContain('db-41')
  expect(feed.shelves.some(shelf => shelf.id === 'hot-tv')).toBe(true)
  expect(feed.shelves.some(shelf => shelf.id === 'new-movie')).toBe(false)
})
const rows = (value: unknown) => {
  const data = value as { items?: unknown }
  if (!Array.isArray(data.items)) throw new DataError('INVALID_RESPONSE', 'Missing array')
  return data.items as number[]
}
it('one canceled reader cannot abort another reader of shared metadata, and cached results are isolated', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let signal: AbortSignal | null | undefined
  const fetcher = vi.fn(async (_input: unknown, options?: RequestInit) => {
    signal = options?.signal
    await gate
    signal?.throwIfAborted()
    return new Response('{"items":[1,2]}')
  })
  const client = new DoubanHttp({ fetch: fetcher as typeof fetch, intervalMs: 0, retries: 0 })
  const canceled = new AbortController()
  const first = client.json(endpoint, 60000, rows, false, 60000, canceled.signal)
  const kept = client.json(endpoint, 60000, rows)
  canceled.abort()
  await expect(first).rejects.toMatchObject({ name: 'AbortError' })
  expect(signal?.aborted).toBe(false)
  release()
  const result = await kept
  result.push(999)
  expect(await client.json(endpoint, 60000, rows)).toEqual([1, 2])
  expect(fetcher).toHaveBeenCalledTimes(1)
})
it('a malformed metadata response is not cached and a later valid response can recover', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response('{"items":"wrong"}')).mockResolvedValueOnce(new Response('{"items":[3]}'))
  const client = new DoubanHttp({ fetch: fetcher, retries: 0, intervalMs: 0 })
  await expect(client.json(endpoint, 60000, rows)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  expect(await client.json(endpoint, 60000, rows)).toEqual([3])
  expect(fetcher).toHaveBeenCalledTimes(2)
})
it('metadata timeouts remain typed failures and do not poison the next request', async () => {
  let calls = 0
  const fetcher: typeof fetch = async (_url, options) => {
    if (++calls > 1) return new Response('{"items":[4]}')
    return new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true }))
  }
  const client = new DoubanHttp({ fetch: fetcher, retries: 0, intervalMs: 0, timeoutMs: 30 })
  await expect(client.json(endpoint, 60000, rows)).rejects.toMatchObject({ code: 'TIMEOUT', retryable: true })
  expect(await client.json(endpoint, 60000, rows)).toEqual([4])
})
it('network concurrency remains bounded through a burst of queued requests', async () => {
  const limiter = new WorkLimiter(2)
  let active = 0, maximum = 0
  const order: number[] = []
  const result = await Promise.all(Array.from({ length: 30 }, (_, i) => limiter.run(async () => {
    active++; maximum = Math.max(maximum, active); order.push(i)
    await Promise.resolve(); await Promise.resolve()
    active--; return i
  })))
  expect(maximum).toBe(2)
  expect(order).toEqual(result)
  expect(active).toBe(0)
})
it('public media URL validation keeps local, credential-bearing and reserved destinations out of the source pool', () => {
  for (const url of ['http://127.0.0.1/movie.mp4', 'http://[::1]/movie.mp4', 'https://name:password@example.org/movie.mp4', 'https://example.org:22/movie.mp4']) expect(() => validatePublicUrl(url)).toThrow()
  expect(isPublicAddress('198.18.0.1')).toBe(false)
  expect(isPublicAddress('::ffff:192.168.1.2')).toBe(false)
  expect(validatePublicUrl('https://media.example.org:18443/movie.mp4').hostname).toBe('media.example.org')
})
it('ad removal preserves every programme segment and refuses changes that would break encryption or tracks', () => {
  const config = loadSourceRules()
  const source = { key: 'fixture', name: 'Fixture catalogue', api: 'https://catalog.example.org/api', enabled: true, priority: 1, adPaths: ['/insert/ads/'], fingerprints: [] }
  const programme = Array.from({ length: 100 }, (_, i) => `#EXTINF:10,\nhttps://media.example.org/show/${i}.ts\n`)
  const insert = '#EXT-X-DISCONTINUITY\n#EXTINF:5,\nhttps://media.example.org/insert/ads/1.ts\n#EXTINF:5,\nhttps://media.example.org/insert/ads/2.ts\n#EXT-X-DISCONTINUITY\n'
  const body = '#EXTM3U\n#EXT-X-TARGETDURATION:10\n' + programme.slice(0, 50).join('') + insert + programme.slice(50).join('') + '#EXT-X-ENDLIST\n'
  const filtered = filterPlaylist(body, new URL('https://media.example.org/show/index.m3u8'), source, config)
  expect(filtered.removedSegments).toBe(2)
  for (let i = 0; i < 100; i++) expect(filtered.text).toContain(`/show/${i}.ts`)
  expect(filtered.text).not.toContain('/insert/ads/')
  const encrypted = body.replace('#EXTM3U', '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://media.example.org/key.bin"')
  expect(filterPlaylist(encrypted, new URL('https://media.example.org/show/index.m3u8'), source, config).text).toBe(encrypted)
  expect(filterPlaylist(body, new URL('https://media.example.org/show/index.m3u8'), source, config, true).text).toBe(body)
})
it('initials are real query hints with correct Chinese numeric and polyphonic matching, never invented film records', () => {
  const dictionary = JSON.parse(readFileSync('resources/search-initials.json', 'utf8')) as InitialsDictionary
  expect(initialQuery('Ｓ Ｔ')).toBe('st')
  expect(initialQuery('S<script>')).toBeUndefined()
  expect(titleSearchScore('三体', 'ST', dictionary)).toBe(0)
  expect(titleSearchScore('流浪地球2', 'LLDQ2', dictionary)).toBe(0)
  expect(Number.isFinite(titleSearchScore('重庆森林', 'CQSL', dictionary))).toBe(true)
  expect(Number.isFinite(titleSearchScore('重庆森林', 'ZQSL', dictionary))).toBe(true)
  expect(titleSearchScore('三体', '三体', dictionary)).toBeLessThan(titleSearchScore('三体', 'ST', dictionary))
  expect(suggestedSubjectIds([
    { id: '41', type: 'movie', url: 'https://movie.douban.com/subject/41/' },
    { id: '41', type: 'movie', url: 'https://movie.douban.com/subject/41/' },
    { id: '42', type: 'movie', url: 'https://movie.douban.com.attacker.example/subject/42/' },
    { id: '43', type: 'book', url: 'https://book.douban.com/subject/43/' },
  ])).toEqual(['41'])
})
