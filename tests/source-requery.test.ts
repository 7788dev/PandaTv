import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MediaItem } from '../design/contract/types'
import type { MediaProxy } from '../src/main/playback/proxy'
import type { SourceRules } from '../src/main/playback/sources'
import { extra } from '../src/copy.extra'
import { safeError } from '../src/main/ipc'

const answers = new Map<string, Array<() => string | Promise<string>>>()
const asked: string[] = []

vi.mock('../src/main/playback/network', async original => ({
  ...(await original<typeof import('../src/main/playback/network')>()),
  getText: async (raw: string | URL) => {
    const url = new URL(String(raw))
    asked.push(url.host)
    const queue = answers.get(url.host) ?? []
    const next = queue.length > 1 ? queue.shift()! : queue[0]!
    return { text: await next(), url }
  },
}))

import { PlaybackService } from '../src/main/playback/service'

const source = (key: string, priority: number) => ({ key, name: key, api: `https://${key}.example.com/api`, enabled: true, priority, adPaths: [], fingerprints: [] })
const rules: SourceRules = { version: 1, verifiedAt: '2026-11-16', maxDropRatio: 0.15, foreignBlockMaxSeconds: 0, sources: [source('one', 2), source('two', 1)] }
const item: MediaItem = { id: 'db-1', title: '生命奇观', year: 2024, type: 'doc', poster: null, backdrop: null, genres: [] }

const empty = () => JSON.stringify({ list: [], pagecount: 1 })
const record = () => JSON.stringify({ pagecount: 1, list: [{ vod_id: 7, vod_name: '生命奇观', vod_year: '2024', type_name: '纪录片', vod_play_from: 'm3u8', vod_play_url: '第1集$https://media.example.com/1.m3u8#第2集$https://media.example.com/2.m3u8#第3集$https://media.example.com/3.m3u8' }] })
const refuse = () => { throw new Error('上游服务暂不可用（503）') }
// What a request to a host whose name resolves to a non-public address fails with.
const unreachable = () => { throw new Error('网络请求失败或超时', { cause: new Error('已拒绝非公开网络地址') }) }
const service = () => new PlaybackService({ proxy: {} as MediaProxy, rules, requeryDelayMs: 0 })

describe('a work only one source carries', () => {
  beforeEach(() => { answers.clear(); asked.length = 0 })

  it('is found when that source fails once and answers when asked again', async () => {
    answers.set('one.example.com', [empty])
    answers.set('two.example.com', [refuse, record])
    await expect(service().availability(item)).resolves.toEqual({ episodes: 3 })
    expect(asked.filter(host => host === 'two.example.com')).toHaveLength(2)
  })

  it('is not called missing while a source that failed twice has yet to answer', async () => {
    answers.set('one.example.com', [empty])
    answers.set('two.example.com', [refuse])
    await expect(service().availability(item)).rejects.toThrow(extra.unavailable)
    expect(asked.filter(host => host === 'two.example.com')).toHaveLength(2)
    expect(asked.filter(host => host === 'one.example.com')).toHaveLength(1)
  })

  it('does not ask twice when every source answered', async () => {
    answers.set('one.example.com', [empty])
    answers.set('two.example.com', [empty])
    await expect(service().availability(item)).rejects.toThrow(extra.sourceUnavailable)
    expect(asked).toHaveLength(2)
  })

  it('does not ask again once another source carries the work', async () => {
    answers.set('one.example.com', [record])
    answers.set('two.example.com', [refuse])
    await expect(service().availability(item)).resolves.toEqual({ episodes: 3 })
    expect(asked.filter(host => host === 'two.example.com')).toHaveLength(1)
  })

  it('leaves a source that keeps failing alone, and stops waiting for it after two minutes', async () => {
    answers.set('one.example.com', [empty])
    answers.set('two.example.com', [refuse])
    const playback = service()
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      // Two works: the two failures of the first search and the first of the next reach three.
      await expect(playback.availability(item)).rejects.toThrow(extra.unavailable)
      asked.length = 0
      await expect(playback.availability({ ...item, id: 'db-2', title: '另一部' })).rejects.toThrow(extra.unavailable)
      expect(asked.filter(host => host === 'two.example.com')).toHaveLength(1)
      vi.setSystemTime(Date.now() + 2 * 60000 + 1)
      await expect(playback.availability({ ...item, id: 'db-3', title: '第三部' })).rejects.toThrow(extra.sourceUnavailable)
    } finally { vi.useRealTimers() }
  })

  it('answers from the source again once it recovers, because a failed search is not kept', async () => {
    answers.set('one.example.com', [empty])
    answers.set('two.example.com', [refuse, refuse, record])
    const playback = service()
    await expect(playback.availability(item)).rejects.toThrow(extra.unavailable)
    await expect(playback.availability(item)).resolves.toEqual({ episodes: 3 })
  })

  it('reaches the interface in words it can show', async () => {
    answers.set('one.example.com', [empty])
    answers.set('two.example.com', [refuse])
    const error = await service().availability(item).catch(value => value as Error)
    expect(safeError(error)).toEqual({ code: 'UNAVAILABLE', message: '暂时无法连接，请重试' })
  })

  it('is called missing at once when the only silent source is one this network cannot reach', async () => {
    answers.set('one.example.com', [empty])
    answers.set('two.example.com', [unreachable])
    await expect(service().availability(item)).rejects.toThrow(extra.sourceUnavailable)
    expect(asked.filter(host => host === 'two.example.com')).toHaveLength(1)
  })

  it('still waits for a stumbling source beside an unreachable one', async () => {
    const three = { ...rules, sources: [...rules.sources, source('three', 0)] }
    answers.set('one.example.com', [empty])
    answers.set('two.example.com', [unreachable])
    answers.set('three.example.com', [refuse, record])
    await expect(new PlaybackService({ proxy: {} as MediaProxy, rules: three, requeryDelayMs: 0 }).availability(item)).resolves.toEqual({ episodes: 3 })
    expect(asked.filter(host => host === 'two.example.com')).toHaveLength(1)
  })

  it('does not wait for a slow source once the work is found, and takes its answer when it comes', async () => {
    const longer = () => new Promise<string>(resolve => setTimeout(() => resolve(record().replace('#第3集', '#第3集$https://media.example.com/3.m3u8#第4集')), 300))
    answers.set('one.example.com', [record])
    answers.set('two.example.com', [longer])
    const playback = new PlaybackService({ proxy: {} as MediaProxy, rules, requeryDelayMs: 0, searchGraceMs: 20 })
    const started = Date.now()
    await expect(playback.availability(item)).resolves.toEqual({ episodes: 3 })
    expect(Date.now() - started).toBeLessThan(250)
    await new Promise(resolve => setTimeout(resolve, 400))
    await expect(playback.availability(item)).resolves.toEqual({ episodes: 4 })
    expect(asked).toHaveLength(2)
  })

  it('starts the last bundled fallback even while the first eight catalogues are still waiting', async () => {
    const sources = Array.from({ length: 9 }, (_, index) => source(`source-${index + 1}`, 9 - index))
    const pool = { ...rules, sources }
    const blocked: Array<() => void> = []
    for (const entry of sources.slice(0, 8)) {
      answers.set(new URL(entry.api).host, [() => new Promise<string>(resolve => blocked.push(() => resolve(empty())))])
    }
    answers.set(new URL(sources[8]!.api).host, [record])

    const lookup = new PlaybackService({ proxy: {} as MediaProxy, rules: pool, requeryDelayMs: 0, searchGraceMs: 20 }).availability(item)
    await new Promise(resolve => setTimeout(resolve, 30))
    const fallbackStartedBeforeRelease = asked.includes(new URL(sources[8]!.api).host)
    blocked.forEach(release => release())

    await expect(lookup).resolves.toEqual({ episodes: 3 })
    expect(fallbackStartedBeforeRelease).toBe(true)
  })

  it('waits for every source while the work has not been found', async () => {
    const slow = () => new Promise<string>(resolve => setTimeout(() => resolve(record()), 150))
    answers.set('one.example.com', [empty])
    answers.set('two.example.com', [slow])
    await expect(new PlaybackService({ proxy: {} as MediaProxy, rules, requeryDelayMs: 0, searchGraceMs: 20 }).availability(item)).resolves.toEqual({ episodes: 3 })
  })

  it('judges a work by the answers to its own search, not by a failure during another one', async () => {
    answers.set('one.example.com', [empty])
    answers.set('two.example.com', [refuse, refuse, empty])
    const playback = service()
    await expect(playback.availability(item)).rejects.toThrow(extra.unavailable)
    await expect(playback.availability({ ...item, id: 'db-2', title: '另一部' })).rejects.toThrow(extra.sourceUnavailable)
    // The failure record of a source is cleared by its answer; one that stays silent for others is not this work's concern.
    answers.set('two.example.com', [refuse, refuse, refuse, refuse])
    const cooling = service()
    await expect(cooling.availability(item)).rejects.toThrow(extra.unavailable)
    await expect(cooling.availability({ ...item, id: 'db-3', title: '第三部' })).rejects.toThrow(extra.unavailable)
  })

  it('says the sources are unreachable when none answered', async () => {
    answers.set('one.example.com', [refuse])
    answers.set('two.example.com', [refuse])
    await expect(service().availability(item)).rejects.toThrow(extra.unavailable)
  })
})
