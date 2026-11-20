import https from 'node:https'
import type { IncomingMessage } from 'node:http'
import { Readable, pipeline } from 'node:stream'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import { watchHandshake } from '../handshake'
import { directEgress } from '../egress'

interface TransportOptions {
  /** How long each new connection may take to connect; one entry per connection tried. */
  handshakeMs?: number[]
  agent?: https.Agent
}

class Reconnect extends Error {}

/**
 * `fetch` for metadata requests, on node's https so that connecting has its own deadline (see
 * watchHandshake): a connection that stalls is dropped and the request is sent on a new one,
 * instead of waiting out the request's whole timeout. GET only, redirects are never followed
 * (the caller checks each target), the answer is decompressed.
 */
export function createTransport(options: TransportOptions = {}): typeof globalThis.fetch {
  const deadlines = options.handshakeMs ?? [1500, 4000]
  const egress = options.agent ? undefined : directEgress()
  const agent = options.agent ?? new https.Agent({ keepAlive: true, maxSockets: 6, ...(egress ? { localAddress: egress.localAddress, lookup: egress.lookup } : {}) })

  const open = (url: URL, headers: Record<string, string>, signal: AbortSignal | undefined, handshakeMs: number) => new Promise<IncomingMessage>((resolve, reject) => {
    const request = https.request(url, { method: 'GET', agent, headers, signal }, resolve)
    watchHandshake(request, handshakeMs, () => request.destroy(new Reconnect('stalled')))
    request.once('error', (error: NodeJS.ErrnoException) => {
      // A kept-alive connection the server has closed in the meantime fails on first use.
      const stale = request.reusedSocket && !signal?.aborted && (error.code === 'ECONNRESET' || error.code === 'EPIPE')
      reject(stale ? new Reconnect('stale') : error)
    })
    request.end()
  })

  return async (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    if (url.protocol !== 'https:' || (init.method ?? 'GET') !== 'GET' || init.body) throw new TypeError('Unsupported metadata request')
    const headers: Record<string, string> = { 'Accept-Encoding': 'gzip, br' }
    new Headers(init.headers).forEach((value, name) => { headers[name] = value })
    const signal = init.signal ?? undefined
    let incoming: IncomingMessage | undefined
    let stalled = 0
    let stale = 0
    while (!incoming) {
      signal?.throwIfAborted()
      try { incoming = await open(url, headers, signal, deadlines[stalled]!) } catch (error) {
        if (!(error instanceof Reconnect)) throw error
        if (error.message === 'stale' ? ++stale > 1 : ++stalled >= deadlines.length) throw new TypeError('Metadata connection could not be established')
      }
    }
    const status = incoming.statusCode ?? 0
    if (status < 200 || status > 599) { incoming.destroy(); throw new TypeError('Unexpected metadata status') }
    const answer = new Headers()
    for (const [name, value] of Object.entries(incoming.headers)) for (const item of value === undefined ? [] : [value].flat()) answer.append(name, item)
    const encoding = answer.get('content-encoding')?.toLowerCase()
    const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'br' ? createBrotliDecompress() : encoding === 'deflate' ? createInflate() : undefined
    let body: Readable = incoming
    if (decoder) {
      body = pipeline(incoming, decoder, () => {})
      answer.delete('content-encoding')
      answer.delete('content-length')
    }
    if ([204, 205, 304].includes(status)) { incoming.resume(); return new Response(null, { status, headers: answer }) }
    return new Response(Readable.toWeb(body) as ReadableStream<Uint8Array>, { status, headers: answer })
  }
}
