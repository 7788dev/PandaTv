import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCipheriv } from 'node:crypto'
import { PassThrough } from 'node:stream'
import captured from './fixtures/segment-heads.json'
import type { MediaItem } from '../design/contract/types'
import type { SourceRules } from '../src/main/playback/sources'

/** How one request for a segment goes: when its first bytes come, when the rest, or how it fails. */
interface Plan { afterMs?: number; firstMs?: number; firstBytes?: number; restMs?: number; status?: number; refused?: boolean; breaksOff?: boolean }
const plans = new Map<string, Plan[]>()
const catalogues = new Map<string, boolean>()
const opened: string[] = []
const playlists: string[] = []
const keys: string[] = []
/** Real heads of first segments (see the fixture): the picture a source's segment holds. */
const head = (picture: string) => Buffer.from(captured.heads.find(entry => entry.picture === picture)!.head, 'base64')
const pictures = new Map<string, string>()
const segmentSeconds = new Map<string, number>()
/** Hosts whose playlist names an AES-128 key, and how the request for that key goes. */
const ciphers = new Map<string, { status?: number }>()
const KEY = Buffer.from('0123456789abcdef'), IV = Buffer.alloc(16, 7)
const NAMES = ['one', 'two', 'three', 'four', 'five']
/** A segment of 2000 bytes: the head of a real one, then the number of its source. */
const clearBody = (host: string) => {
  const start = pictures.get(host) === 'none' ? Buffer.alloc(0) : head(pictures.get(host) ?? '1920x1080')
  return Buffer.concat([start, Buffer.alloc(2000 - start.length, NAMES.indexOf(host.split('-')[0]!) + 1)])
}
const body = (host: string) => {
  if (!ciphers.has(host)) return clearBody(host)
  const cipher = createCipheriv('aes-128-cbc', KEY, IV)
  return Buffer.concat([cipher.update(clearBody(host)), cipher.final()])
}

vi.mock('../src/main/playback/network', async original => ({
  ...(await original<typeof import('../src/main/playback/network')>()),
  getText: async (raw: string | URL) => {
    const url = new URL(String(raw))
    if (url.pathname === '/api') {
      const key = url.host.split('.')[0]!
      const list = catalogues.get(key) ? [{ vod_id: 7, vod_name: '生命奇观', vod_year: '2024', type_name: '纪录片', vod_play_from: 'm3u8', vod_play_url: `第1集$https://${key}-media.example.com/1.m3u8#第2集$https://${key}-media.example.com/2.m3u8` }] : []
      return { text: JSON.stringify({ pagecount: 1, list }), url }
    }
    playlists.push(url.href)
    const key = ciphers.has(url.host) ? `#EXT-X-KEY:METHOD=AES-128,URI="enc.key",IV=0x${IV.toString('hex')}\n` : ''
    const seconds = segmentSeconds.get(url.host) ?? 10
    return { text: `#EXTM3U\n#EXT-X-TARGETDURATION:10\n${key}#EXTINF:${seconds},\nseg0.ts\n#EXTINF:${seconds},\nseg1.ts\n#EXT-X-ENDLIST\n`, url }
  },
  openPublic: async (raw: string | URL, options: { signal?: AbortSignal } = {}) => {
    const url = new URL(String(raw))
    if (url.pathname.endsWith('/enc.key')) {
      keys.push(url.host)
      const stream = new PassThrough()
      const status = ciphers.get(url.host)?.status ?? 200
      stream.end(status === 200 ? KEY : undefined)
      return { response: Object.assign(stream, { statusCode: status, headers: { 'content-type': 'application/octet-stream' } }), url }
    }
    opened.push(url.host)
    const queue = plans.get(url.host) ?? [{}]
    const plan = queue.length > 1 ? queue.shift()! : queue[0]!
    if (plan.afterMs) await new Promise(resolve => setTimeout(resolve, plan.afterMs))
    if (plan.refused) throw new Error('网络请求失败或超时', { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) })
    const bytes = body(url.host)
    const stream = new PassThrough()
    const response = Object.assign(stream, { statusCode: plan.status ?? 200, headers: { 'content-type': 'video/mp2t', 'content-length': String(bytes.length) } })
    options.signal?.addEventListener('abort', () => stream.destroy(new Error('aborted')), { once: true })
    stream.on('error', () => {})
    if (response.statusCode !== 200) stream.end()
    else setTimeout(() => {
      if (stream.destroyed) return
      const opening = plan.firstBytes ?? 1000
      stream.write(bytes.subarray(0, opening))
      setTimeout(() => { if (stream.destroyed) return; if (plan.breaksOff) stream.destroy(new Error('reset')); else stream.end(bytes.subarray(opening)) }, plan.restMs ?? 0)
    }, plan.firstMs ?? 0)
    return { response, url }
  },
}))

import { MediaProxy } from '../src/main/playback/proxy'
import { PlaybackService } from '../src/main/playback/service'

const source = (key: string, priority: number) => ({ key, name: key, api: `https://${key}.example.com/api`, enabled: true, priority, adPaths: [], fingerprints: [] })
const rules: SourceRules = { version: 1, verifiedAt: '2026-11-17', maxDropRatio: 0.15, foreignBlockMaxSeconds: 0, sources: [source('one', 3), source('two', 2), source('three', 1)] }
const item: MediaItem = { id: 'db-1', title: '生命奇观', year: 2024, type: 'doc', poster: null, backdrop: null, genres: [] }

let proxy: MediaProxy
const service = (firstSegmentGraceMs = 30, more: { betterPictureMs?: number; turnMs?: number } = {}) => new PlaybackService({ proxy, rules, requeryDelayMs: 0, firstSegmentGraceMs, betterPictureMs: 150, ...more })
/** What the player gets: the playlist behind a playback address, and the bytes of its first segment. */
async function firstSegment(address: string) {
  const text = await (await fetch(address)).text()
  const first = text.split('\n').find(line => line && !line.startsWith('#'))!
  return { text, bytes: Buffer.from(await (await fetch(first)).arrayBuffer()) }
}
const from = (bytes: Buffer) => NAMES[bytes.at(-1)! - 1]

describe('starting an episode', () => {
  beforeEach(async () => {
    plans.clear(); catalogues.clear(); pictures.clear(); segmentSeconds.clear(); ciphers.clear(); opened.length = 0; playlists.length = 0; keys.length = 0
    catalogues.set('one', true)
    proxy = new MediaProxy({ rules }); await proxy.start()
  })
  afterEach(() => proxy.close())

  it('answers the player\'s first requests from what choosing the source already read', async () => {
    const playback = await service().resolve(item, 1)
    const { text, bytes } = await firstSegment(playback.url)
    expect(text.split('\n').filter(line => line.startsWith('http://127.0.0.1:'))).toHaveLength(2)
    expect(bytes.equals(body('one'))).toBe(true)
    expect(playlists).toEqual(['https://one-media.example.com/1.m3u8'])
    expect(opened).toEqual(['one-media.example.com'])
  })

  it('lets the player join a first segment that is still arriving instead of asking for it again', async () => {
    plans.set('one-media.example.com', [{ restMs: 250 }])
    const started = Date.now()
    const playback = await service().resolve(item, 1)
    expect(Date.now() - started).toBeLessThan(200)
    const { bytes } = await firstSegment(playback.url)
    expect(bytes.equals(body('one'))).toBe(true)
    expect(opened).toEqual(['one-media.example.com'])
  })

  it('cuts the player short when the download it joined breaks off, and serves it from the source when asked again', async () => {
    plans.set('one-media.example.com', [{ restMs: 150, breaksOff: true }, {}])
    const playback = await service().resolve(item, 1)
    await expect(firstSegment(playback.url)).rejects.toThrow()
    const { bytes } = await firstSegment(playback.url)
    expect(bytes.equals(body('one'))).toBe(true)
  })

  it('prefers the source that delivers a whole first segment to the one that answered first', async () => {
    catalogues.set('two', true)
    plans.set('one-media.example.com', [{ restMs: 400 }])
    plans.set('two-media.example.com', [{ firstMs: 60 }])
    const playback = await service(250).resolve(item, 1)
    expect(from((await firstSegment(playback.url)).bytes)).toBe('two')
  })

  it('tries the previous episode winner first while continuing to race other sources', async () => {
    catalogues.set('two', true)
    pictures.set('one-media.example.com', '864x326')
    pictures.set('two-media.example.com', '1920x1080')
    const playback = service(30, { betterPictureMs: 50 })
    expect((await playback.resolve(item, 1)).quality).toBe('1080P')

    opened.length = 0
    expect((await playback.resolve(item, 2)).quality).toBe('1080P')
    expect(opened[0]).toBe('two-media.example.com')
    expect(opened).toContain('one-media.example.com')
  })

  it('keeps a failed source behind for this work without penalizing other titles', async () => {
    catalogues.set('two', true)
    plans.set('one-media.example.com', [{ status: 404 }, {}])
    const playback = service()
    await playback.resolve(item, 1)

    opened.length = 0
    await playback.resolve(item, 2)
    expect(opened[0]).toBe('two-media.example.com')

    opened.length = 0
    await playback.resolve({ ...item, id: 'db-other' }, 1)
    expect(opened[0]).toBe('one-media.example.com')
  })

  it('rechecks the previous source when every replacement fails', async () => {
    const playback = service()
    catalogues.set('two', true)
    plans.set('two-media.example.com', [{ status: 404 }])
    await playback.resolve(item, 1, undefined, false, {}, 'one')

    opened.length = 0
    const recovered = await playback.resolve(item, 1, undefined, true)
    expect(opened).toEqual(['two-media.example.com', 'one-media.example.com'])
    expect(from((await firstSegment(recovered.url)).bytes)).toBe('one')
  })

  it('prefers a smooth smaller picture over HD that downloads slower than it plays', async () => {
    catalogues.set('two', true)
    pictures.set('two-media.example.com', '1080x606')
    segmentSeconds.set('one-media.example.com', 0.08)
    plans.set('one-media.example.com', [{ restMs: 130 }])
    plans.set('two-media.example.com', [{ firstMs: 180 }])
    const playback = await service(500, { betterPictureMs: 300 }).resolve(item, 1)
    expect(from((await firstSegment(playback.url)).bytes)).toBe('two')
    expect(playback.quality).toBe('480P')
  })

  it('compares partial delivery against media bitrate instead of raw downloaded bytes', async () => {
    catalogues.set('two', true)
    segmentSeconds.set('one-media.example.com', 0.05)
    plans.set('one-media.example.com', [{ firstBytes: 1600, restMs: 500 }])
    plans.set('two-media.example.com', [{ firstBytes: 800, restMs: 500 }])
    const playback = await service(160).resolve(item, 1)
    expect(from((await firstSegment(playback.url)).bytes)).toBe('two')
  })

  it('plays a source that has answered when none delivers a whole segment in time', async () => {
    catalogues.set('two', true)
    plans.set('one-media.example.com', [{ restMs: 1000 }])
    plans.set('two-media.example.com', [{ firstMs: 100, restMs: 1000 }])
    const started = Date.now()
    const playback = await service(200).resolve(item, 1)
    const chosenIn = Date.now() - started
    // Both sources have answered; timer scheduling can change which equal candidate
    // appears faster, but selection must not wait for either 1 s segment to finish.
    expect(['one', 'two']).toContain(from((await firstSegment(playback.url)).bytes))
    expect(chosenIn).toBeLessThan(800)
  })

  it('passes over a source whose first segment breaks off', async () => {
    catalogues.set('two', true)
    plans.set('one-media.example.com', [{ restMs: 20, breaksOff: true }])
    plans.set('two-media.example.com', [{ firstMs: 50, restMs: 300 }])
    const playback = await service(100).resolve(item, 1)
    expect(from((await firstSegment(playback.url)).bytes)).toBe('two')
  })

  it('gives a source that replaced a dead one the same time to show its speed', async () => {
    catalogues.set('two', true); catalogues.set('three', true)
    plans.set('one-media.example.com', [{ restMs: 600 }])
    plans.set('two-media.example.com', [{ afterMs: 80, status: 404 }])
    plans.set('three-media.example.com', [{ firstMs: 60 }])
    const playback = await service(100).resolve(item, 1)
    expect(from((await firstSegment(playback.url)).bytes)).toBe('three')
  })

  it('asks every source in turn, three at a time, until one answers', async () => {
    const many: SourceRules = { ...rules, sources: ['one', 'two', 'three', 'four', 'five'].map((key, index) => source(key, 9 - index)) }
    for (const key of ['one', 'two', 'three', 'four', 'five']) { catalogues.set(key, true); plans.set(key + '-media.example.com', [{ status: key === 'five' ? 200 : 404 }]) }
    const playback = await new PlaybackService({ proxy, rules: many, requeryDelayMs: 0, firstSegmentGraceMs: 30 }).resolve(item, 1)
    expect(playback.format).toBe('hls')
    expect(opened).toEqual(['one', 'two', 'three', 'four', 'five'].map(key => key + '-media.example.com'))
  })

  it('does not let three slow sources hold up a fourth that is fast', async () => {
    const many: SourceRules = { ...rules, sources: ['one', 'two', 'three', 'four'].map((key, index) => source(key, 9 - index)) }
    for (const key of ['one', 'two', 'three', 'four']) { catalogues.set(key, true); plans.set(key + '-media.example.com', [{ restMs: key === 'four' ? 0 : 5000 }]) }
    const playback = new PlaybackService({ proxy, rules: many, requeryDelayMs: 0, firstSegmentGraceMs: 400, turnMs: 80 })
    const started = Date.now()
    expect(from((await firstSegment((await playback.resolve(item, 1)).url)).bytes)).toBe('four')
    expect(Date.now() - started).toBeLessThan(400)
    // What was slow from here is asked after the others for the next episode.
    opened.length = 0
    expect(from((await firstSegment((await playback.resolve(item, 2)).url)).bytes)).toBe('four')
    expect(opened[0]).toBe('four-media.example.com')
  })

  it('plays the source whose download comes in fastest when none delivers a whole segment', async () => {
    catalogues.set('two', true)
    plans.set('one-media.example.com', [{ firstBytes: 800, restMs: 2000 }])
    plans.set('two-media.example.com', [{ firstBytes: 1600, restMs: 2000 }])
    const playback = await service(200).resolve(item, 1)
    expect(from((await firstSegment(playback.url)).bytes)).toBe('two')
  })

  it('names the picture that the first segment holds', async () => {
    pictures.set('one-media.example.com', '1080x606')
    expect((await service().resolve(item, 1)).quality).toBe('480P')
    pictures.set('one-media.example.com', '1920x800')
    expect((await service().resolve(item, 2)).quality).toBe('1080P')
    // Nothing is said of a picture that cannot be read.
    pictures.set('one-media.example.com', 'none')
    expect((await service().resolve(item, 1))).not.toHaveProperty('quality')
  })

  it('holds a small picture back for a source that shows the one asked for', async () => {
    catalogues.set('two', true)
    pictures.set('one-media.example.com', '864x326')
    plans.set('two-media.example.com', [{ firstMs: 80 }])
    const playback = await service().resolve(item, 1)
    expect(playback.quality).toBe('1080P')
    expect(from((await firstSegment(playback.url)).bytes)).toBe('two')
  })

  it('gives a picture below 720P one more moment while another source is downloading, and only one', async () => {
    catalogues.set('two', true)
    pictures.set('one-media.example.com', '864x326')
    plans.set('two-media.example.com', [{ firstMs: 20, restMs: 230 }])
    expect((await service(3000).resolve(item, 1)).quality).toBe('1080P')
    plans.set('two-media.example.com', [{ firstMs: 20, restMs: 1500 }])
    const started = Date.now()
    expect((await service(3000).resolve(item, 2)).quality).toBe('480P')
    expect(Date.now() - started).toBeGreaterThanOrEqual(290)
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('plays the small picture when nothing better comes in a moment later, and at once when no other source is left', async () => {
    catalogues.set('two', true)
    pictures.set('one-media.example.com', '864x326')
    plans.set('two-media.example.com', [{ firstMs: 1500 }])
    let started = Date.now()
    const playback = await service(3000).resolve(item, 1)
    expect(Date.now() - started).toBeGreaterThanOrEqual(140)
    expect(Date.now() - started).toBeLessThan(1000)
    expect(playback.quality).toBe('480P')
    expect(from((await firstSegment(playback.url)).bytes)).toBe('one')
    catalogues.set('two', false)
    started = Date.now()
    expect((await service(3000).resolve(item, 2)).quality).toBe('480P')
    expect(Date.now() - started).toBeLessThan(120)
  })

  it('does not hold back a picture that is as large as the viewer asked for', async () => {
    catalogues.set('two', true)
    pictures.set('one-media.example.com', '1080x606')
    plans.set('two-media.example.com', [{ firstMs: 80 }])
    const playback = await service().resolve(item, 1, '480P')
    expect(from((await firstSegment(playback.url)).bytes)).toBe('one')
  })

  it('reads the picture of an encrypted segment and keeps its key for the player', async () => {
    ciphers.set('one-media.example.com', {})
    const playback = await service().resolve(item, 1)
    expect(playback.quality).toBe('1080P')
    const text = await (await fetch(playback.url)).text()
    const key = /URI="([^"]+)"/.exec(text)![1]!
    expect(key.startsWith('http://127.0.0.1:')).toBe(true)
    expect(Buffer.from(await (await fetch(key)).arrayBuffer()).equals(KEY)).toBe(true)
    // Asked of the source once, by the probe.
    expect(keys).toEqual(['one-media.example.com'])
  })

  it('passes over a source that does not hand over its key', async () => {
    catalogues.set('two', true)
    ciphers.set('one-media.example.com', { status: 403 })
    const failures: string[] = []
    const playback = new PlaybackService({ proxy, rules, requeryDelayMs: 0, firstSegmentGraceMs: 30, onSourceFailure: (key, reason) => failures.push(key + ' ' + reason) })
    expect(from((await firstSegment((await playback.resolve(item, 1)).url)).bytes)).toBe('two')
    expect(failures).toEqual(['one probe: 播放密钥不可用（403）'])
  })

  it('asks last, for a while, the source the player gave up on', async () => {
    catalogues.set('two', true); catalogues.set('three', true)
    const playback = service()
    expect(from((await firstSegment((await playback.resolve(item, 1)).url)).bytes)).toBe('one')
    expect(from((await firstSegment((await playback.resolve(item, 1, undefined, true)).url)).bytes)).toBe('two')
    opened.length = 0
    await playback.resolve(item, 2)
    expect(opened[0]).toBe('two-media.example.com')
  })

  it('asks a source again when its connection failed in passing', async () => {
    plans.set('one-media.example.com', [{ refused: true }, {}])
    const failures: string[] = []
    const playback = new PlaybackService({ proxy, rules, requeryDelayMs: 0, firstSegmentGraceMs: 30, onSourceFailure: (key, reason) => failures.push(key + ' ' + reason) })
    await expect(playback.resolve(item, 1)).resolves.toMatchObject({ format: 'hls' })
    expect(opened).toHaveLength(2)
    expect(failures).toEqual(['one probe: 网络请求失败或超时 / ECONNRESET'])
  })

  it('does not ask again a source that says the episode is gone, and does not keep the failure', async () => {
    plans.set('one-media.example.com', [{ status: 404 }, {}])
    const playback = service()
    await expect(playback.resolve(item, 1)).rejects.toThrow('片源暂时无法连接，请重试')
    expect(opened).toHaveLength(1)
    await expect(playback.resolve(item, 1)).resolves.toMatchObject({ format: 'hls' })
  })

  it('lists the sources that carry an episode and says which one it plays from', async () => {
    catalogues.set('two', true)
    const playback = service()
    expect(await playback.sources(item, 1)).toEqual({ list: [{ key: 'one', name: 'one' }, { key: 'two', name: 'two' }] })
    await playback.resolve(item, 1)
    expect((await playback.sources(item, 1)).current).toBe('one')
    await expect(playback.sources(item, 9)).rejects.toThrow('未找到这一集的可用片源')
  })

  it('plays from the source the viewer picked, and starts the next episode there too', async () => {
    catalogues.set('two', true)
    const playback = service()
    expect(from((await firstSegment((await playback.resolve(item, 1)).url)).bytes)).toBe('one')
    const picked = await playback.resolve(item, 1, undefined, false, {}, 'two')
    expect(from((await firstSegment(picked.url)).bytes)).toBe('two')
    expect((await playback.sources(item, 1)).current).toBe('two')
    // Asking again without naming a source keeps what was picked.
    expect(await playback.resolve(item, 1)).toBe(picked)
    expect(from((await firstSegment((await playback.resolve(item, 2)).url)).bytes)).toBe('two')
    expect((await playback.sources(item, 2)).current).toBe('two')
  })

  it('does not put another source in the place of the one that was picked', async () => {
    catalogues.set('two', true)
    plans.set('two-media.example.com', [{ status: 404 }])
    const playback = service()
    await expect(playback.resolve(item, 1, undefined, false, {}, 'two')).rejects.toThrow('片源暂时无法连接，请重试')
    await expect(playback.resolve(item, 1, undefined, false, {}, 'three')).rejects.toThrow('未找到这一集的可用片源')
    // The episode itself still plays, from a source that has it.
    expect(from((await firstSegment((await playback.resolve(item, 1)).url)).bytes)).toBe('one')
  })

  it('reuses the choice for an episode, so asking ahead makes pressing play immediate', async () => {
    const playback = service()
    const ahead = await playback.resolve(item, 2)
    expect(await playback.resolve(item, 2)).toBe(ahead)
    expect(opened).toHaveLength(1)
    await playback.resolve(item, 2, undefined, true)
    expect(opened).toHaveLength(2)
    await playback.resolve(item, 1)
    expect(opened).toHaveLength(3)
  })
})
