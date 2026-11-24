import { createServer, type Server, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { filterPlaylist, hasSynchronizedTracks, rewritePlaylist, type FilterResult } from './filter'
import { openPublic, readLimited, validatePublicUrl, WorkLimiter } from './network'
import { loadSourceRules, type PlaySource, type SourceRules } from './sources'
import { ImageCache } from './image-cache'

interface Capability { url: string; kind: 'image' | 'media'; source?: PlaySource; preserveTimeline: boolean; usedAt: number }
export interface ProxyOptions {
  rules?: SourceRules
  onDiagnostic?: (source: string, result: Omit<FilterResult, 'text'>) => void
  /** Told about artwork that failed or took more than three seconds, with what each attempt cost. */
  onSlowImage?: (report: { host: string; ms: number; served: boolean; attempts: { ms: number; error?: string }[] }) => void
  /** Where artwork is kept between runs; without it every image is downloaded in every run. */
  imageDir?: string
}

export function isDoubanImage(url: URL): boolean {
  return url.protocol === 'https:' && (url.hostname === 'doubanio.com' || url.hostname.endsWith('.doubanio.com'))
}

export function normalizeRange(value: string | undefined): string | undefined {
  if (!value) return undefined
  if (/^bytes=-\d+$/.test(value)) {
    const suffix = Number(value.slice(7))
    if (Number.isSafeInteger(suffix) && suffix > 0) return value
    throw new Error('无效的媒体范围')
  }
  if (!/^bytes=\d+-\d*$/.test(value)) throw new Error('无效的媒体范围')
  const [start, end] = value.slice(6).split('-').map(Number)
  if (!Number.isSafeInteger(start) || start < 0 || (value.endsWith('-') ? false : (!Number.isSafeInteger(end) || end < start))) throw new Error('无效的媒体范围')
  return value
}

/** What a probe read is kept this long, and in all this many bytes, for the request the player makes next. */
const WARM_MS = 3 * 60_000
const WARM_BYTES = 48 * 1024 * 1024
const WARM_ITEM_BYTES = 8 * 1024 * 1024
/** No single segment is passed on beyond this. */
const SEGMENT_BYTES = 64 * 1024 * 1024

/** A segment that is still arriving: what has come so far, and who is reading along. */
interface Flow { type: string; length?: number; parts: Buffer[]; size: number; listeners: Set<(event: Buffer | 'end' | 'fail') => void> }
export interface SharedSegment { /** False once nobody needs the rest: stop reading. */ write(chunk: Buffer): boolean; end(): void; fail(): void }
/**
 * `cipher`: the segment is encrypted whole with AES-128; where its key is, and its IV.
 * `sealed`: it is encrypted in a way that is not read here (sample encryption, DRM).
 */
export interface FirstSegment { url: URL; seconds?: number; cipher?: { key: URL; iv: Buffer }; sealed?: boolean }

/** Per attempt at a poster: ms to connect, ms without a byte, ms in all. */
const IMAGE_ATTEMPTS = [[1500, 2500, 6000], [2500, 5000, 9000], [5000, 8000, 15000]] as const

export class MediaProxy {
  private server?: Server
  private origin = ''
  private readonly capabilities = new Map<string, Capability>()
  private readonly byTarget = new Map<string, string>()
  private readonly limiter = new WorkLimiter(10)
  private readonly rules: SourceRules
  private readonly images?: ImageCache
  private pruneTimer?: ReturnType<typeof setTimeout>
  private readonly warmed = new Map<string, { body: Buffer; type: string; url: URL; expires: number }>()
  private warmedBytes = 0
  private readonly flows = new Map<string, Flow>()
  readonly diagnostics = new Map<string, Omit<FilterResult, 'text'>>()
  constructor(private readonly options: ProxyOptions = {}) {
    this.rules = options.rules ?? loadSourceRules()
    if (options.imageDir) this.images = new ImageCache(options.imageDir)
  }

  async start(): Promise<void> {
    if (this.server) return
    this.server = createServer((request, response) => {
      response.setHeader('Access-Control-Allow-Origin', '*')
      response.setHeader('Access-Control-Allow-Headers', 'Range')
      response.setHeader('Access-Control-Expose-Headers', 'Content-Length,Content-Range,Accept-Ranges')
      response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
      response.setHeader('X-Content-Type-Options', 'nosniff')
      if (request.method === 'OPTIONS') { response.writeHead(204).end(); return }
      if (!['GET', 'HEAD'].includes(request.method ?? '')) { response.writeHead(405).end(); return }
      const expectedHost = new URL(this.origin).host
      if (request.headers.host !== expectedHost) { response.writeHead(403).end(); return }
      const match = /^\/asset\/([a-f0-9]{48})$/.exec(request.url ?? '')
      const cap = match ? this.capabilities.get(match[1]!) : undefined
      if (!cap) { response.writeHead(404).end(); return }
      cap.usedAt = Date.now()
      // Artwork is immutable per URL and its handle is stable for the session, so the
      // renderer may reuse it; playlists and segments must always reflect the live upstream.
      response.setHeader('Cache-Control', cap.kind === 'image' ? 'private, max-age=86400, immutable' : 'no-store')
      const controller = new AbortController()
      response.once('close', () => { if (!response.writableFinished) controller.abort() })
      this.limiter.run(() => this.serve(cap, request.method === 'HEAD', request.headers.range, response, controller.signal)).catch(() => {
        if (!response.headersSent) response.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
        if (!response.destroyed) response.end('资源暂不可用')
      })
    })
    await new Promise<void>((resolve, reject) => { this.server!.once('error', reject); this.server!.listen(0, '127.0.0.1', () => resolve()) })
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('无法启动媒体服务')
    this.origin = `http://127.0.0.1:${address.port}`
    // Tidying the artwork directory can wait until the first page is on screen.
    this.pruneTimer = setTimeout(() => void this.images?.prune(), 20000)
    this.pruneTimer.unref?.()
  }

  async close(): Promise<void> {
    clearTimeout(this.pruneTimer)
    this.server?.closeAllConnections()
    if (this.server) await new Promise<void>(resolve => this.server!.close(() => resolve()))
    await this.images?.close()
    this.server = undefined; this.origin = ''; this.capabilities.clear(); this.byTarget.clear(); this.warmed.clear(); this.warmedBytes = 0
    for (const flow of this.flows.values()) flow.listeners.forEach(tell => tell('fail'))
    this.flows.clear()
  }

  /**
   * Keeps a playlist or segment that choosing a source already downloaded, so that the player's
   * own request for it is answered from memory instead of asking the source a second time.
   * `final` is the address that answered (after redirects); relative addresses resolve against it.
   */
  warm(requested: string, final: URL, body: Buffer, type: string): void {
    if (!body.length || body.length > WARM_ITEM_BYTES) return
    const key = validatePublicUrl(requested).href
    this.forget(key)
    this.warmed.set(key, { body, type, url: final, expires: Date.now() + WARM_MS })
    this.warmedBytes += body.length
    for (const [known, entry] of this.warmed) {
      if (this.warmedBytes <= WARM_BYTES && entry.expires > Date.now()) break
      this.forget(known)
    }
  }
  /**
   * A segment that choosing a source is still downloading. The player's request for it joins
   * that download where it is instead of starting it over, which on a slow source is most of
   * the wait for the first picture. Once complete it is kept like anything else that was read.
   */
  share(requested: URL, type: string, length?: number): SharedSegment {
    const key = validatePublicUrl(requested).href
    const flow: Flow = { type, length, parts: [], size: 0, listeners: new Set() }
    this.flows.get(key)?.listeners.forEach(tell => tell('fail'))
    this.flows.set(key, flow)
    const close = (event: 'end' | 'fail') => {
      if (this.flows.get(key) === flow) this.flows.delete(key)
      for (const tell of [...flow.listeners]) tell(event)
      flow.listeners.clear()
    }
    return {
      write: chunk => {
        flow.size += chunk.length
        if (flow.size > WARM_ITEM_BYTES) {
          // Too large to keep. Whoever is reading along gets the rest; nobody else joins.
          if (this.flows.get(key) === flow) this.flows.delete(key)
          flow.parts = []
          if (!flow.listeners.size) return false
          if (flow.size > SEGMENT_BYTES) { close('fail'); return false }
        } else flow.parts.push(chunk)
        for (const tell of flow.listeners) tell(chunk)
        return true
      },
      end: () => {
        if (flow.size <= WARM_ITEM_BYTES) this.warm(key, requested, Buffer.concat(flow.parts), type)
        close('end')
      },
      fail: () => close('fail'),
    }
  }
  private join(flow: Flow, client: ServerResponse, signal: AbortSignal): Promise<void> {
    return new Promise(resolve => {
      client.writeHead(200, { 'Content-Type': flow.type || 'application/octet-stream', ...(flow.length ? { 'Content-Length': flow.length } : {}) })
      for (const part of flow.parts) client.write(part)
      const tell = (event: Buffer | 'end' | 'fail') => {
        if (typeof event !== 'string') { client.write(event); return }
        // A download that broke off is cut short for the player too, which then asks again.
        if (event === 'end') client.end(); else client.destroy()
        resolve()
      }
      flow.listeners.add(tell)
      signal.addEventListener('abort', () => { flow.listeners.delete(tell); resolve() }, { once: true })
    })
  }
  private forget(key: string) {
    const entry = this.warmed.get(key)
    if (entry) { this.warmedBytes -= entry.body.length; this.warmed.delete(key) }
  }
  private kept(key: string) {
    const entry = this.warmed.get(key)
    if (entry && entry.expires <= Date.now()) { this.forget(key); return undefined }
    return entry
  }
  /**
   * The first segment the player will ask for: the first one left after ad removal, and what
   * it takes to read it.
   */
  firstSegment(text: string, url: URL, source: PlaySource, preserveTimeline: boolean): FirstSegment | undefined {
    const filtered = filterPlaylist(text, url, source, this.rules, preserveTimeline || hasSynchronizedTracks(text)).text
    let key: string | undefined, sequence = 0, seconds: number | undefined
    for (const raw of filtered.split(/\r?\n/)) {
      const line = raw.trim()
      if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) sequence = Number(line.slice(22)) || 0
      else if (line.startsWith('#EXTINF:')) { const value = Number(line.slice(8).split(',')[0]); seconds = Number.isFinite(value) && value > 0 ? value : undefined }
      else if (line.startsWith('#EXT-X-KEY:')) key = line
      else if (line && !line.startsWith('#')) {
        const segment = new URL(line, url)
        if (!key || /METHOD=NONE/.test(key)) return { url: segment, seconds }
        const uri = /URI="([^"]+)"/.exec(key)?.[1]
        if (!/METHOD=AES-128(?:,|$)/.test(key) || !uri) return { url: segment, seconds, sealed: true }
        // Without an IV of its own a segment is encrypted with its sequence number (RFC 8216, 5.2).
        const stated = /IV=0x([0-9a-f]{1,32})/i.exec(key)?.[1]
        const iv = Buffer.alloc(16)
        if (stated) Buffer.from(stated.padStart(32, '0'), 'hex').copy(iv); else iv.writeUInt32BE(sequence >>> 0, 12)
        return { url: segment, seconds, cipher: { key: new URL(uri, url), iv } }
      }
    }
    return undefined
  }

  registerImage(raw: string): string {
    const url = validatePublicUrl(raw)
    if (!isDoubanImage(url)) throw new Error('图片来源不受支持')
    return this.register({ url: url.href, kind: 'image', preserveTimeline: true, usedAt: Date.now() })
  }

  registerMedia(raw: string, source: PlaySource, preserveTimeline = false): string {
    return this.register({ url: validatePublicUrl(raw).href, source, kind: 'media', preserveTimeline, usedAt: Date.now() })
  }

  private register(cap: Capability): string {
    if (!this.origin) throw new Error('媒体服务尚未就绪')
    const identity = `${cap.kind}|${cap.source?.key ?? ''}|${cap.preserveTimeline}|${cap.url}`
    let token = this.byTarget.get(identity)
    if (token && this.capabilities.has(token)) { this.capabilities.get(token)!.usedAt = Date.now(); return `${this.origin}/asset/${token}` }
    // Bound opaque capabilities. A long movie needs thousands of segment entries.
    if (this.capabilities.size >= 40000) {
      const oldest = [...this.capabilities.entries()].sort((a, b) => a[1].usedAt - b[1].usedAt).slice(0, 8000)
      for (const [id] of oldest) this.capabilities.delete(id)
      for (const [key, id] of this.byTarget) if (!this.capabilities.has(id)) this.byTarget.delete(key)
    }
    token = randomBytes(24).toString('hex'); this.capabilities.set(token, cap); this.byTarget.set(identity, token)
    return `${this.origin}/asset/${token}`
  }

  private async serve(cap: Capability, head: boolean, range: string | undefined, client: ServerResponse, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return
    if (cap.kind === 'image') return this.serveImage(cap, head, client, signal)
    const playlistBody = (text: string, url: URL) => {
      if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('播放清单格式无效')
      const preserve = cap.preserveTimeline || hasSynchronizedTracks(text)
      const result = filterPlaylist(text, url, cap.source!, this.rules, preserve)
      const { text: filtered, ...diagnostic } = result
      this.diagnostics.set(cap.source!.key, diagnostic); this.options.onDiagnostic?.(cap.source!.key, diagnostic)
      const body = Buffer.from(rewritePlaylist(filtered, url, upstream => this.registerMedia(upstream.href, cap.source!, preserve)))
      client.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Content-Length': body.length }); client.end(body)
    }
    const isPlaylist = (url: URL, type: string) => /\.m3u8(?:$|\?)/i.test(url.pathname) || /mpegurl/i.test(type)
    // What choosing the source already read answers the player's first requests.
    const kept = head || range ? undefined : this.kept(cap.url)
    if (kept) {
      if (isPlaylist(kept.url, kept.type)) return playlistBody(kept.body.toString('utf8'), kept.url)
      client.writeHead(200, { 'Content-Type': kept.type || 'application/octet-stream', 'Content-Length': kept.body.length }); client.end(kept.body); return
    }
    const flow = head || range ? undefined : this.flows.get(cap.url)
    if (flow) return this.join(flow, client, signal)
    const headers: Record<string, string> = {}
    if (range) headers.Range = normalizeRange(range)!
    const { response, url } = await openPublic(cap.url, { method: head ? 'HEAD' : 'GET', headers, timeoutMs: 20000, signal })
    const status = response.statusCode ?? 502
    if (status < 200 || status >= 300) {
      if (status === 416 && typeof response.headers['content-range'] === 'string') client.setHeader('Content-Range', response.headers['content-range'])
      response.destroy(); client.writeHead(status, { 'Cache-Control': 'no-store' }).end(); return
    }
    const type = String(response.headers['content-type'] ?? '')
    if (isPlaylist(url, type) && !head) return playlistBody((await readLimited(response, 4 * 1024 * 1024)).toString('utf8'), url)
    if (/(?:text\/html|application\/json)/i.test(type)) { response.destroy(); throw new Error('上游未返回媒体') }
    const outHeaders: Record<string, string> = { 'Content-Type': type || 'application/octet-stream' }
    for (const name of ['content-length', 'content-range', 'accept-ranges']) if (typeof response.headers[name] === 'string') outHeaders[name] = response.headers[name]!
    client.writeHead(status, outHeaders)
    if (head) { response.destroy(); client.end(); return }
    let bytes = 0
    // Files stream with backpressure; individual segment responses have bounded size.
    const capBytes = /\.mp4$/i.test(url.pathname) ? Infinity : SEGMENT_BYTES
    const budget = new Transform({ transform(chunk: Buffer, _encoding, callback) { bytes += chunk.length; callback(bytes > capBytes ? new Error('资源超过大小限制') : null, chunk) } })
    await pipeline(response, budget, client, { signal })
  }

  /**
   * Artwork is small, so it is read whole before the window gets any of it: an answer that
   * stalls or breaks off half way can then be asked for again instead of leaving a card
   * without its poster, and a complete image can be kept for the next run.
   */
  private async serveImage(cap: Capability, head: boolean, client: ServerResponse, signal: AbortSignal): Promise<void> {
    const saved = await this.images?.get(cap.url)
    if (saved) {
      client.writeHead(200, { 'Content-Type': saved.type, 'Content-Length': saved.body.length })
      client.end(head ? undefined : saved.body); return
    }
    let failure: unknown
    const began = Date.now()
    const attempts: { ms: number; error?: string }[] = []
    const report = (served: boolean) => {
      if (signal.aborted || (served && Date.now() - began < 3000)) return
      this.options.onSlowImage?.({ host: new URL(cap.url).hostname, ms: Date.now() - began, served, attempts })
    }
    for (let attempt = 0; attempt < IMAGE_ATTEMPTS.length; attempt++) {
      if (signal.aborted) return
      let opened: Awaited<ReturnType<typeof openPublic>>
      let body: Buffer | undefined
      const started = Date.now()
      try {
        // A poster normally arrives within half a second; now and then a new connection never
        // finishes connecting, or an answer stops half way (measured 2026-11-17). The first
        // attempt therefore gives up early and the later ones are more patient.
        const [handshake, idle, total] = IMAGE_ATTEMPTS[attempt]!
        opened = await openPublic(cap.url, { method: head ? 'HEAD' : 'GET', headers: { Referer: 'https://movie.douban.com/' }, handshakeMs: handshake, timeoutMs: idle, signal: AbortSignal.any([signal, AbortSignal.timeout(total)]) })
        const status = opened.response.statusCode ?? 502
        if (status >= 500) { opened.response.destroy(); throw new Error('图片服务暂不可用') }
        if (status >= 200 && status < 300 && !head && isDoubanImage(opened.url)) {
          body = await readLimited(opened.response, 12 * 1024 * 1024)
          const declared = Number(opened.response.headers['content-length'])
          if (Number.isFinite(declared) && declared !== body.length) throw new Error('图片不完整')
        }
      } catch (error) { failure = error; attempts.push({ ms: Date.now() - started, error: error instanceof Error ? error.message : String(error) }); continue }
      attempts.push({ ms: Date.now() - started })
      // What Douban did answer is final: another address, an error, something that is no image.
      const { response, url } = opened
      const status = response.statusCode ?? 502
      if (!isDoubanImage(url)) { response.destroy(); throw new Error('图片重定向来源不受支持') }
      if (status < 200 || status >= 300) { response.destroy(); client.writeHead(status, { 'Cache-Control': 'no-store' }).end(); return }
      const type = String(response.headers['content-type'] ?? '')
      if (!/^image\/(?:jpeg|png|webp|avif|gif)(?:;|$)/i.test(type)) { response.destroy(); throw new Error('图片格式无效') }
      if (!body) {
        const length = response.headers['content-length']
        response.destroy(); client.writeHead(status, { 'Content-Type': type, ...(typeof length === 'string' ? { 'Content-Length': length } : {}) }).end(); return
      }
      client.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length })
      client.end(body)
      report(true)
      if (status === 200) await this.images?.put(cap.url, body)
      return
    }
    report(false)
    throw failure
  }
}
