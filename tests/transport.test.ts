import { readFileSync } from 'node:fs'
import https from 'node:https'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { gzipSync } from 'node:zlib'
import { afterEach, expect, it } from 'vitest'
import { createTransport } from '../src/main/data/transport'

// A loopback TLS server behind a front that behaves like the local proxy the fault was measured
// behind: every TCP connection is accepted at once, and the chosen ones are then left without a
// byte, so their TLS handshake never completes.
const cert = readFileSync(new URL('./fixtures/loopback-cert.pem', import.meta.url))
const key = readFileSync(new URL('./fixtures/loopback-key.pem', import.meta.url))
const closers: Array<() => void> = []
afterEach(() => { for (const close of closers.splice(0)) close() })

async function setup(swallow: (connection: number) => boolean, handshakeMs = [150, 2000]) {
  const requests: string[] = []
  const server = https.createServer({ key, cert }, (request, response) => {
    requests.push(request.url ?? '')
    if (request.url === '/silent') return
    if (request.url === '/moved') { response.writeHead(302, { Location: '/list' }); response.end(); return }
    const body = gzipSync(JSON.stringify({ items: [{ id: '1' }], path: request.url }))
    response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Content-Length': body.length })
    response.end(body)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const sockets = new Set<net.Socket>()
  let connections = 0
  const front = net.createServer(socket => {
    sockets.add(socket)
    socket.on('error', () => {})
    if (swallow(++connections)) return
    const upstream = net.connect((server.address() as AddressInfo).port, '127.0.0.1')
    sockets.add(upstream)
    upstream.on('error', () => {})
    socket.pipe(upstream).pipe(socket)
  })
  await new Promise<void>(resolve => front.listen(0, '127.0.0.1', resolve))
  const agent = new https.Agent({ keepAlive: true, ca: cert })
  closers.push(() => { agent.destroy(); for (const socket of sockets) socket.destroy(); front.close(); server.close(); server.closeAllConnections() })
  return { fetch: createTransport({ handshakeMs, agent }), origin: `https://127.0.0.1:${(front.address() as AddressInfo).port}`, requests, connections: () => connections }
}

it('replaces a connection whose handshake stalls instead of waiting out the request', async () => {
  const { fetch, origin, requests, connections } = await setup(connection => connection === 1)
  const started = Date.now()
  const response = await fetch(origin + '/list', { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ items: [{ id: '1' }], path: '/list' })
  // The stalled connection cost its handshake deadline, not the caller's eight seconds.
  expect(Date.now() - started).toBeLessThan(2000)
  expect(connections()).toBe(2)
  expect(requests).toEqual(['/list'])
})

it('fails as a network error, not a timeout, when no connection can be established', async () => {
  const { fetch, origin, requests, connections } = await setup(() => true, [100, 200])
  const failure = await fetch(origin + '/list', { signal: AbortSignal.timeout(8000) }).catch((error: Error) => error)
  expect(failure).toBeInstanceOf(TypeError)
  expect(connections()).toBe(2)
  expect(requests).toEqual([])
})

it('leaves a connected but unanswered request to the caller\'s deadline, and sends it once', async () => {
  const { fetch, origin, requests, connections } = await setup(() => false)
  const failure = await fetch(origin + '/silent', { signal: AbortSignal.timeout(400) }).catch((error: Error) => error)
  expect(['AbortError', 'TimeoutError']).toContain((failure as Error).name)
  expect(requests).toEqual(['/silent'])
  expect(connections()).toBe(1)
})

it('hands redirects to the caller, decompresses answers and keeps the connection for the next request', async () => {
  const { fetch, origin, requests, connections } = await setup(() => false)
  const moved = await fetch(origin + '/moved', { redirect: 'manual' })
  expect(moved.status).toBe(302)
  expect(moved.headers.get('location')).toBe('/list')
  await moved.body?.cancel()
  const first = await fetch(origin + '/a')
  expect(first.headers.get('content-encoding')).toBeNull()
  expect(await first.json()).toMatchObject({ path: '/a' })
  const second = await fetch(origin + '/b')
  expect(await second.json()).toMatchObject({ path: '/b' })
  expect(requests).toEqual(['/moved', '/a', '/b'])
  // /a opened a connection at the latest; /b reused it.
  expect(connections()).toBeLessThanOrEqual(2)
  await expect(fetch(origin + '/list', { method: 'POST' })).rejects.toBeInstanceOf(TypeError)
  await expect(fetch(origin.replace('https:', 'http:') + '/list')).rejects.toBeInstanceOf(TypeError)
})
