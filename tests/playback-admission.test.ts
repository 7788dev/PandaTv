import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import type { MediaItem } from '../src/contract/types'
import { MediaProxy } from '../src/main/playback/proxy'
import { PlaybackService } from '../src/main/playback/service'
import { loadSourceRules, type SourceRules } from '../src/main/playback/sources'

const transport = vi.hoisted(() => ({ getText: vi.fn(), openPublic: vi.fn() }))
vi.mock(import('../src/main/playback/network'), async original => ({ ...await original(), ...transport }))

const movie: MediaItem = { id: 'db-41', title: '回归影片', type: 'movie', year: 2023, genres: [], poster: null, backdrop: null }
const serial: MediaItem = { ...movie, id: 'db-42', title: '回归剧集', type: 'tv', episodes: 3 }
const mp4 = Buffer.from('000000186674797069736f6d0000000069736f6d6d703432', 'hex')
const proxies: MediaProxy[] = []
const responses: PassThrough[] = []
const failures: string[] = []
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function rules(keys = ['a', 'b', 'c']): SourceRules {
  return { ...loadSourceRules(), sources: keys.map((key, i) => ({ key, name: key, api: `https://${key}.catalog.example.org/api`, enabled: true, priority: 20 - i, adPaths: [], fingerprints: [] })) }
}
async function service(keys?: string[]) {
  const config = rules(keys)
  const proxy = new MediaProxy({ rules: config })
  await proxy.start()
  proxies.push(proxy)
  return new PlaybackService({ proxy, rules: config, searchGraceMs: 10, betterPictureMs: 20, firstSegmentGraceMs: 100, turnMs: 100, onSourceFailure: (key, reason) => failures.push(`${key}: ${reason}`) })
}
function catalogue(item = movie, format = 'mp4') {
  transport.getText.mockImplementation(async (raw: string) => {
    const url = new URL(raw), source = url.hostname.split('.')[0]
    if (!url.hostname.includes('.catalog.')) {
      const quality = source === 'a' ? '480' : '720'
      return { url, text: url.pathname.endsWith('master.m3u8')
        ? `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=${quality === '480' ? '854x480' : '1280x720'}\nmain.m3u8\n`
        : '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nfirst.ts\n#EXT-X-ENDLIST\n' }
    }
    const entries = item.type === 'movie' ? [`正片$https://${source}.media.example.org/episode-1.${format}`]
      : [1, 2, 3].map(number => `第${number}集$https://${source}.media.example.org/episode-${number}.${format}`)
    return { url, text: JSON.stringify({ pagecount: 1, list: [{ vod_id: 1, vod_name: item.title, vod_year: '2023', type_name: item.type === 'movie' ? '电影' : '电视剧', vod_play_from: format, vod_play_url: entries.join('#') }] }) }
  })
}
function response(url: string, bytes = mp4, type = 'video/mp4', status = 200) {
  const stream = new PassThrough()
  Object.assign(stream, { statusCode: status, complete: true, headers: { 'content-type': type, 'content-length': String(bytes.length) } })
  stream.end(bytes)
  responses.push(stream)
  return { url: new URL(url), response: stream as unknown as IncomingMessage }
}
beforeEach(() => { failures.length = 0; transport.getText.mockReset(); transport.openPublic.mockReset(); catalogue() })
afterEach(async () => { for (const stream of responses.splice(0)) stream.destroy(); await Promise.all(proxies.splice(0).map(proxy => proxy.close())) })

describe('source admission and selection ownership', () => {
  it('rejects empty and JSON MP4 responses, selects the working fallback and closes probes', async () => {
    transport.openPublic.mockImplementation(async (url: string) => response(url, url.includes('a.media') ? Buffer.alloc(0) : url.includes('b.media') ? Buffer.from('{"error":"offline"}') : mp4, url.includes('b.media') ? 'application/json' : 'video/mp4'))
    const client = await service()
    await client.resolve(movie, 1)
    expect((await client.sources(movie, 1)).current).toBe('c')
    expect(transport.openPublic).toHaveBeenCalledTimes(3)
    await delay(1)
    expect(responses.every(stream => stream.destroyed)).toBe(true)
  })

  it('waits for actual MP4 bytes after successful headers and accepts a split 206 header', async () => {
    const stream = new PassThrough()
    Object.assign(stream, { statusCode: 206, headers: { 'content-type': 'application/octet-stream' } })
    responses.push(stream)
    transport.openPublic.mockResolvedValue({ url: 'https://a.media.example.org/episode-1.mp4', response: stream })
    const client = await service(['a'])
    let selected = false
    const pending = client.resolve(movie, 1).then(value => { selected = true; return value })
    await delay(15)
    expect(selected).toBe(false)
    stream.write(mp4.subarray(0, 4))
    await delay(10)
    expect(selected).toBe(false)
    stream.end(mp4.subarray(4))
    expect((await pending).format).toBe('mp4')
    expect((await client.sources(movie, 1)).current).toBe('a')
  })

  it('does not accept non-media bytes even when the server labels them video/mp4', async () => {
    transport.openPublic.mockImplementation(async (url: string) => response(url, Buffer.from('{"error":"not a movie"}')))
    const client = await service(['a'])
    await expect(client.resolve(movie, 1)).rejects.toThrow('片源暂时无法连接')
    expect((await client.sources(movie, 1)).current).toBeUndefined()
  })

  it('keeps the newer automatic winner when an older automatic request finishes late', async () => {
    let release!: () => void
    const oldGate = new Promise<void>(resolve => { release = resolve })
    const calls = { a: 0, b: 0 }
    transport.openPublic.mockImplementation(async (url: string) => {
      const key = new URL(url).hostname[0] as 'a' | 'b', n = ++calls[key]
      if (key === 'a' && n === 1) await oldGate
      else if ((key === 'a' && n === 2) || (key === 'b' && n === 1)) throw new Error('媒体不可用')
      return response(url)
    })
    const client = await service(['a', 'b'])
    const old = client.resolve(movie, 1)
    while (calls.a + calls.b < 2) await delay(2)
    try {
      const current = await client.resolve(movie, 1, undefined, true)
      expect((await client.sources(movie, 1)).current).toBe('b')
      release()
      expect((await old).url).not.toBe(current.url)
      expect((await client.sources(movie, 1)).current).toBe('b')
      expect((await client.resolve(movie, 1)).url).toBe(current.url)
    } finally { release(); await old }
  })

  it('does not let a late manual request replace a newer automatic fallback', async () => {
    catalogue(serial)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let firstStarted = false, aCalls = 0
    transport.openPublic.mockImplementation(async (url: string) => {
      if (url.includes('a.media')) {
        if (++aCalls === 1) { firstStarted = true; await gate }
        else throw new Error('媒体不可用')
      }
      return response(url)
    })
    const client = await service(['a', 'b'])
    const old = client.resolve(serial, 1, undefined, false, {}, 'a')
    while (!firstStarted) await delay(2)
    try {
      await client.resolve(serial, 1, undefined, true)
      release(); await old
      expect((await client.sources(serial, 1)).current).toBe('b')
      const next = await client.resolve(serial, 2)
      expect(next.format).toBe('mp4')
      expect((await client.sources(serial, 2)).current).toBe('b')
    } finally { release(); await old }
  })

  it('preserves a successful manual preference and invalidates the preloaded next episode', async () => {
    catalogue(serial)
    let preparing = true
    transport.openPublic.mockImplementation(async (url: string) => {
      if (preparing && url.includes('a.media')) throw new Error('媒体不可用')
      return response(url)
    })
    const client = await service(['a', 'b'])
    await client.resolve(serial, 2)
    expect((await client.sources(serial, 2)).current).toBe('b')
    preparing = false
    await client.resolve(serial, 1, undefined, false, {}, 'a')
    const callsBefore = transport.openPublic.mock.calls.length
    await client.resolve(serial, 2)
    expect((await client.sources(serial, 2)).current).toBe('a')
    expect(transport.openPublic.mock.calls.slice(callsBefore).every(([url]) => String(url).includes('a.media'))).toBe(true)
  })

  it('selects the actual better HLS picture rather than the first low-quality response', async () => {
    catalogue(movie, 'm3u8')
    const heads = JSON.parse(readFileSync('tv/app/src/test/resources/media-heads.json', 'utf8')).heads as Array<{ source: string; head: string }>
    transport.openPublic.mockImplementation(async (raw: string | URL) => {
      const url = String(raw)
      const high = url.includes('b.media')
      if (high) await delay(15)
      const sample = heads.find(head => head.source === (high ? 'generated-720' : 'generated-480'))!
      return response(url, Buffer.from(sample.head, 'base64'), 'video/mp2t')
    })
    const client = await service(['a', 'b'])
    const picked = await client.resolve(movie, 1, '720P').catch(error => { throw new Error(`${error.message}; ${failures.join(' | ')}`) })
    expect(picked.quality).toBe('720P')
    expect((await client.sources(movie, 1)).current).toBe('b')
  })

  it('rejects invalid episode numbers before requesting a catalogue', async () => {
    const client = await service()
    await expect(client.resolve(movie, 0)).rejects.toThrow('集数无效')
    await expect(client.resolve(movie, 10001)).rejects.toThrow('集数无效')
    expect(transport.getText).not.toHaveBeenCalled()
  })

  it('admits the correct adaptation and regular episode while a failed mirror falls back to its other address', async () => {
    const item = { ...serial, title: '三体', region: '中国大陆' }
    transport.getText.mockImplementation(async (raw: string) => ({ url: new URL(raw), text: JSON.stringify({ pagecount: 1, list: [
      { vod_id: 2, vod_name: '三体第一季', vod_year: '2023–', vod_area: '美国', type_name: '欧美剧', vod_play_from: 'mp4',
        vod_play_url: Array.from({ length: 8 }, (_, i) => `第${i + 1}集$https://a.media.example.org/remake-${i + 1}.mp4`).join('#') },
      { vod_id: 1, vod_name: '三体', vod_year: '2023', vod_area: '中国大陆', type_name: '国产剧', vod_play_from: 'mp4',
        vod_play_url: ['彩蛋$https://a.media.example.org/bonus.mp4', '第1集$https://a.media.example.org/primary-1.mp4',
          '第1集$https://a.media.example.org/mirror-1.mp4', ...Array.from({ length: 29 }, (_, i) => `第${i + 2}集$https://a.media.example.org/primary-${i + 2}.mp4`)].join('#') },
    ] }) }))
    transport.openPublic.mockImplementation(async (url: string) => response(url, url.includes('primary-1.') ? Buffer.from('{"error":"offline"}') : mp4))
    const client = await service(['a'])
    expect((await client.availability(item)).episodes).toBe(30)
    await client.resolve(item, 1)
    const requested = transport.openPublic.mock.calls.map(([url]) => String(url))
    expect(requested.sort()).toEqual(['https://a.media.example.org/mirror-1.mp4', 'https://a.media.example.org/primary-1.mp4'])
    expect((await client.sources(item, 1)).current).toBe('a')
  })

  it('includes production region in the candidate cache identity', async () => {
    const item = { ...serial, title: '三体', region: '中国大陆' }
    transport.getText.mockImplementation(async (raw: string) => ({ url: new URL(raw), text: JSON.stringify({ pagecount: 1, list: [
      { vod_id: 1, vod_name: '三体', vod_year: '2023', vod_area: '中国大陆', type_name: '国产剧', vod_play_from: 'mp4', vod_play_url: '第1集$https://a.media.example.org/cn-1.mp4#第2集$https://a.media.example.org/cn-2.mp4' },
      { vod_id: 2, vod_name: '三体', vod_year: '2023', vod_area: '美国', type_name: '欧美剧', vod_play_from: 'mp4', vod_play_url: '第1集$https://a.media.example.org/us-1.mp4#第2集$https://a.media.example.org/us-2.mp4#第3集$https://a.media.example.org/us-3.mp4' },
    ] }) }))
    const client = await service(['a'])
    transport.openPublic.mockImplementation(async (url: string) => response(url))
    expect((await client.availability(item)).episodes).toBe(2)
    const chinese = await client.resolve(item, 1)
    expect((await client.availability({ ...item, region: '美国' })).episodes).toBe(3)
    const american = await client.resolve({ ...item, region: '美国' }, 1)
    expect(american.url).not.toBe(chinese.url)
    expect(transport.openPublic.mock.calls.map(([url]) => String(url))).toEqual(['https://a.media.example.org/cn-1.mp4', 'https://a.media.example.org/us-1.mp4'])
    expect(transport.getText).toHaveBeenCalledTimes(2)
  })

  it('a cached quality cannot restore an old playback while leaving the newer source selected', async () => {
    catalogue(movie, 'm3u8')
    const heads = JSON.parse(readFileSync('tv/app/src/test/resources/media-heads.json', 'utf8')).heads as Array<{ source: string; head: string }>
    const requests: string[] = []
    transport.openPublic.mockImplementation(async (raw: string | URL) => {
      const url = String(raw), high = url.includes('b.media')
      requests.push(high ? 'b' : 'a')
      if (high) await delay(15)
      const sample = heads.find(head => head.source === (high ? 'generated-720' : 'generated-480'))!
      return response(url, Buffer.from(sample.head, 'base64'), 'video/mp2t')
    })
    const client = await service(['a', 'b'])
    await client.resolve(movie, 1, '480P')
    expect((await client.sources(movie, 1)).current).toBe('a')
    await client.resolve(movie, 1, '720P')
    expect((await client.sources(movie, 1)).current).toBe('b')
    const before = requests.length
    await client.resolve(movie, 1, '480P')
    expect((await client.sources(movie, 1)).current).toBe('a')
    expect(requests.length).toBeGreaterThan(before)
    const cached = requests.length
    await client.resolve(movie, 1, '480P')
    expect(requests.length).toBe(cached)
  })
})
