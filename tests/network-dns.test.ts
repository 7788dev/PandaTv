import { afterEach, expect, it, vi } from 'vitest'
import dns from 'node:dns'
import https from 'node:https'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { openPublic } from '../src/main/playback/network'
import { subtitleParts } from '../src/main/data/normalize'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

function network(address: string) {
  vi.spyOn(dns, 'lookup').mockImplementation(((_host: string, _options: unknown, callback: Function) => callback(null, [{ address, family: 4 }])) as typeof dns.lookup)
  const connected: string[] = []
  vi.spyOn(https, 'request').mockImplementation(((url: URL, options: any, ready: Function) => {
    const request = new EventEmitter() as any
    request.setTimeout = () => request
    request.destroy = (error: Error) => request.emit('error', error)
    request.end = () => options.agent.options.lookup(url.hostname, { all: true }, (error: Error | null, addresses: { address: string }[]) => {
      if (error) return request.emit('error', error)
      connected.push(...addresses.map(value => value.address))
      const response = Object.assign(new PassThrough(), { statusCode: 200, headers: {} })
      ready(response)
      response.end('real media bytes')
    })
    return request
  }) as typeof https.request)
  return connected
}

it('resolves proxy FakeIP mappings to validated public addresses before connecting', async () => {
  const connected = network('198.18.1.192')
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ Status: 0, Answer: [{ type: 1, TTL: 20, data: '45.253.16.17' }] })))
  vi.stubGlobal('fetch', fetcher)
  const result = await openPublic('https://image-fakeip.example/poster.jpg')
  result.response.destroy()
  expect(connected).toEqual(['45.253.16.17'])
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('still rejects LAN DNS answers without consulting a public fallback', async () => {
  network('192.168.1.10')
  const fetcher = vi.fn()
  vi.stubGlobal('fetch', fetcher)
  await expect(openPublic('https://lan-dns.example/video.m3u8')).rejects.toThrow()
  expect(fetcher).not.toHaveBeenCalled()
})

it('rejects private addresses returned by HTTPS DNS providers', async () => {
  network('198.18.1.193')
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({ Status: 0, Answer: [{ type: 1, TTL: 20, data: '127.0.0.1' }] }))))
  await expect(openPublic('https://poisoned-dns.example/video.m3u8')).rejects.toThrow()
})

const answer = (address: string) => new Response(JSON.stringify({ Status: 0, Answer: [{ type: 1, TTL: 20, data: address }] }))

it('asks the second resolver when the first hangs, and takes whichever answers', async () => {
  const connected = network('198.18.1.194')
  const asked: string[] = []
  vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string, init: { signal: AbortSignal }) => {
    const host = new URL(input).hostname
    asked.push(host)
    // The first resolver never answers; only its own timeout would end the request.
    if (asked.length === 1) return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('timeout'))))
    return Promise.resolve(answer('45.253.16.18'))
  }))
  const started = Date.now()
  const result = await openPublic('https://hanging-resolver.example/poster.jpg')
  result.response.destroy()
  expect(connected).toEqual(['45.253.16.18'])
  expect(asked).toHaveLength(2)
  expect(asked[0]).not.toBe(asked[1])
  // Well before the first resolver's four-second timeout.
  expect(Date.now() - started).toBeLessThan(2500)
})

it('asks the second resolver at once when the first fails, and fails when neither gives a public address', async () => {
  const connected = network('198.18.1.195')
  const fetcher = vi.fn().mockResolvedValueOnce(new Response('busy', { status: 503 })).mockResolvedValueOnce(answer('45.253.16.19'))
  vi.stubGlobal('fetch', fetcher)
  const started = Date.now()
  const result = await openPublic('https://failing-resolver.example/poster.jpg')
  result.response.destroy()
  expect(connected).toEqual(['45.253.16.19'])
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(Date.now() - started).toBeLessThan(500)

  network('198.18.1.196')
  const none = vi.fn().mockImplementation(async () => new Response('busy', { status: 503 }))
  vi.stubGlobal('fetch', none)
  await expect(openPublic('https://no-resolver.example/poster.jpg')).rejects.toThrow()
  expect(none).toHaveBeenCalledTimes(2)
})

it('asks both resolvers again when neither answered the first time', async () => {
  const connected = network('198.18.1.198')
  const asked: string[] = []
  vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string, init: { signal: AbortSignal }) => {
    asked.push(new URL(input).hostname)
    // The first request to each resolver hangs; a new request is answered.
    if (asked.length <= 2) return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('timeout'))))
    return Promise.resolve(answer('45.253.16.20'))
  }))
  const started = Date.now()
  const result = await openPublic('https://both-resolvers-hang.example/poster.jpg')
  result.response.destroy()
  expect(connected).toEqual(['45.253.16.20'])
  expect(asked).toHaveLength(4)
  expect(new Set(asked.slice(2)).size).toBe(2)
  // After the quick deadline, not after the patient one.
  expect(Date.now() - started).toBeGreaterThanOrEqual(1400)
  expect(Date.now() - started).toBeLessThan(3500)
})

it('connects to another address of the host first after one stalled while connecting', async () => {
  vi.spyOn(dns, 'lookup').mockImplementation(((_host: string, _options: unknown, callback: Function) => callback(null, [{ address: '198.18.1.197', family: 4 }])) as typeof dns.lookup)
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({ Status: 0, Answer: ['45.253.16.30', '45.253.16.31', '45.253.16.32'].map(data => ({ type: 1, TTL: 60, data })) }))))
  const offered: string[][] = []
  vi.spyOn(https, 'request').mockImplementation(((url: URL, options: any, ready: Function) => {
    const request = new EventEmitter() as any
    request.setTimeout = () => request
    request.destroy = (error: Error) => { request.emit('error', error); request.emit('close') }
    request.end = () => options.agent.options.lookup(url.hostname, { all: true }, (_error: Error | null, addresses: { address: string }[]) => {
      offered.push(addresses.map(value => value.address))
      // The connection is accepted by the first address offered. The first one made never
      // finishes its handshake; later ones answer.
      request.socket = Object.assign(new EventEmitter(), { remoteAddress: addresses[0]!.address })
      request.emit('socket', request.socket)
      if (offered.length === 1) return
      const response = Object.assign(new PassThrough(), { statusCode: 200, headers: {} })
      ready(response)
      response.end('poster')
    })
    return request
  }) as typeof https.request)

  await expect(openPublic('https://stalling-address.example/poster.jpg', { handshakeMs: 60 })).rejects.toThrow('网络请求失败或超时')
  const second = await openPublic('https://stalling-address.example/poster.jpg', { handshakeMs: 60 })
  second.response.destroy()
  expect(offered).toEqual([['45.253.16.30', '45.253.16.31', '45.253.16.32'], ['45.253.16.31', '45.253.16.32', '45.253.16.30']])
})

it('does not display director names as film genres when a subtitle lacks genres', () => {
  expect(subtitleParts('2026 / 爱沙尼亚 / Eeva Mägi').genres).toEqual([])
})
