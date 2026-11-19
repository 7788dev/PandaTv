import http, { type IncomingMessage, type RequestOptions } from 'node:http'
import https from 'node:https'
import dns from 'node:dns'
import { isIP } from 'node:net'
import { watchHandshake } from '../handshake'

export function isPublicAddress(raw: string): boolean {
  const ip = raw.toLowerCase().replace(/^\[|\]$/g, '')
  if (ip.startsWith('::ffff:')) return isPublicAddress(ip.slice(7))
  if (isIP(ip) === 4) {
    const [a = 0, b = 0] = ip.split('.').map(Number)
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)))
  }
  if (isIP(ip) === 6) return !(ip === '::' || ip === '::1' || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip) || ip.startsWith('ff') || ip.startsWith('2001:db8:'))
  return false
}

/**
 * The ports browsers refuse to fetch from: the Fetch standard's "bad ports" (mail, SSH, DNS, IRC,
 * SIP, X11, NFS and the like). Media CDNs serve HLS on whatever port they have free, 18443 and
 * 65 among those seen, and a browser plays them; requests to other services' ports stay refused.
 */
const BAD_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427,
  465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666,
  6667, 6668, 6669, 6679, 6697, 10080,
])
export const allowedPort = (port: number) => Number.isInteger(port) && port >= 1 && port <= 65535 && !BAD_PORTS.has(port)

const NOT_PUBLIC = '已拒绝非公开网络地址'
/**
 * The name resolves, and to an address that is not on the public network: the answer some CDNs
 * give to the regions they do not serve (measured 2026-11-17 from Beijing: 360zy.com → 127.0.0.2
 * from both the system resolver and public ones). That is a verdict on this network, not a
 * stumble: asking again gives the same answer.
 */
export const unreachableHere = (error: unknown): boolean => error instanceof Error && (error.message === NOT_PUBLIC || unreachableHere(error.cause))

export function validatePublicUrl(raw: string | URL): URL {
  const url = new URL(raw)
  const host = url.hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '')
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('不支持的播放地址')
  if (!host || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host) || (isIP(host) && !isPublicAddress(host))) throw new Error(NOT_PUBLIC)
  if (url.port && !allowedPort(Number(url.port))) throw new Error('已拒绝非标准网络端口')
  return url
}

const dnsCache = new Map<string, { addresses: dns.LookupAddress[]; expires: number }>()
const dnsFlights = new Map<string, Promise<dns.LookupAddress[]>>()
const DNS_RESOLVERS = ['https://dns.alidns.com/resolve', 'https://cloudflare-dns.com/dns-query'] as const
const DNS_HEDGE_MS = 350
const DNS_QUICK_MS = 1500
const DNS_PATIENT_MS = 4000
const isFakeIp = (address: string) => /^198\.(?:18|19)\./.test(address) && isIP(address) === 4

async function publicDns(hostname: string): Promise<dns.LookupAddress[]> {
  const cached = dnsCache.get(hostname)
  if (cached && cached.expires > Date.now()) return cached.addresses
  const flight = dnsFlights.get(hostname)
  if (flight) return flight
  // Some local network proxies return 198.18/15 mappings. Never connect to those
  // reserved addresses: resolve through authenticated public DNS, then pin the IP.
  let unanswered = false
  const ask = async (resolver: string, timeoutMs: number) => {
    let response: Response
    try {
      response = await fetch(resolver + '?name=' + encodeURIComponent(hostname) + '&type=A', {
        headers: { Accept: 'application/dns-json' }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) { unanswered = true; throw error }
    if (!response.ok) { await response.body?.cancel(); throw new Error('resolver unavailable') }
    const body = await response.text()
    if (body.length > 32768) throw new Error('resolver answer too large')
    const data = JSON.parse(body) as { Status?: number; Answer?: { type: number; TTL: number; data: string }[] }
    const answers = data.Status === 0 && Array.isArray(data.Answer) ? data.Answer.filter(answer => answer.type === 1) : []
    if (!answers.length || answers.some(answer => !isPublicAddress(answer.data))) throw new Error('no public address')
    return { addresses: answers.map(answer => ({ address: answer.data, family: 4 })), ttl: Math.max(5, Math.min(60, ...answers.map(answer => Number(answer.TTL) || 5))) }
  }
  // A resolver answers in 40–300 ms, but now and then a request to one hangs until its timeout
  // (measured 2026-11-17: the posters of one host then waited four seconds, or failed when it
  // happened to both). So the second resolver is asked when the first fails or has not answered
  // within DNS_HEDGE_MS, neither is waited on for longer than DNS_QUICK_MS, and when a request
  // went unanswered both are asked once more with patience. The first usable answer is taken;
  // an answer that names no public address is final, and there is no private-IP fallback.
  const work = (async () => {
    const first = ask(DNS_RESOLVERS[0], DNS_QUICK_MS)
    let timer: ReturnType<typeof setTimeout> | undefined
    const second = new Promise<void>(resolve => { timer = setTimeout(resolve, DNS_HEDGE_MS); first.catch(() => resolve()) }).then(() => ask(DNS_RESOLVERS[1], DNS_QUICK_MS))
    try {
      const { addresses, ttl } = await Promise.any([first, second])
        .catch(error => { if (!unanswered) throw error; return Promise.any(DNS_RESOLVERS.map(resolver => ask(resolver, DNS_PATIENT_MS))) })
      if (dnsCache.size >= 256) dnsCache.delete(dnsCache.keys().next().value!)
      dnsCache.set(hostname, { addresses, expires: Date.now() + ttl * 1000 })
      return addresses
    } catch { throw new Error('无法确认公开网络地址') } finally { clearTimeout(timer) }
  })().finally(() => dnsFlights.delete(hostname))
  dnsFlights.set(hostname, work)
  return work
}

// Addresses on which a connection stalled lately (see watchHandshake). A host usually has
// several; the next connection goes to another one first instead of the one that just stalled.
const STALLED_MS = 30_000
const stalledAt = new Map<string, number>()
const stalledLately = (address: string) => Date.now() - (stalledAt.get(address) ?? -Infinity) < STALLED_MS
function markStalled(address: string | undefined) {
  if (!address) return
  if (stalledAt.size >= 64) for (const known of [...stalledAt.keys()]) if (!stalledLately(known)) stalledAt.delete(known)
  if (stalledAt.size < 64) stalledAt.set(address, Date.now())
}

const publicLookup: RequestOptions['lookup'] = (hostname, options, callback) => {
  const done = (found: dns.LookupAddress[]) => {
    const addresses = [...found.filter(row => !stalledLately(row.address)), ...found.filter(row => stalledLately(row.address))]
    if (!addresses.length || addresses.some(row => !isPublicAddress(row.address))) return callback(new Error(NOT_PUBLIC), '', 0)
    if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: typeof addresses) => void)(null, addresses)
    const selected = addresses.find(row => row.family === options.family) ?? addresses[0]!
    callback(null, selected.address, selected.family)
  }
  dns.lookup(hostname, { all: true, order: 'verbatim' }, (error, addresses) => {
    if (error || (addresses.length && addresses.every(row => isFakeIp(row.address)))) {
      void publicDns(hostname).then(done, error => callback(error, '', 0))
    } else done(addresses)
  })
}

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 8, lookup: publicLookup })
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 12, lookup: publicLookup })

export interface NetworkOptions { timeoutMs?: number; /** Deadline for a new connection to finish connecting; see watchHandshake. */ handshakeMs?: number; signal?: AbortSignal; headers?: Record<string, string>; method?: 'GET' | 'HEAD' }
export interface NetworkResponse { response: IncomingMessage; url: URL }

export async function openPublic(raw: string | URL, options: NetworkOptions = {}, depth = 0): Promise<NetworkResponse> {
  const url = validatePublicUrl(raw)
  if (depth > 5) throw new Error('网络重定向次数过多')
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method: options.method ?? 'GET', agent: url.protocol === 'https:' ? httpsAgent : httpAgent,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36', 'Accept': '*/*', 'Accept-Encoding': 'identity', 'Referer': `${url.origin}/`, ...options.headers },
      signal: options.signal,
    }, resolve)
    request.setTimeout(options.timeoutMs ?? 12000, () => request.destroy(new Error('连接超时')))
    if (options.handshakeMs) watchHandshake(request, options.handshakeMs, () => { markStalled(request.socket?.remoteAddress); request.destroy(new Error('连接超时')) })
    request.once('error', cause => reject(new Error(options.signal?.aborted ? '请求已取消' : '网络请求失败或超时', { cause })))
    request.end()
  })
  if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0) && response.headers.location) {
    response.destroy()
    return openPublic(new URL(response.headers.location, url), options, depth + 1)
  }
  return { response, url }
}

export async function readLimited(response: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(response.headers['content-length'])
  if (Number.isFinite(declared) && declared > limit) { response.destroy(); throw new Error('上游响应过大') }
  const chunks: Buffer[] = []; let size = 0
  for await (const data of response) {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data)
    size += chunk.length
    if (size > limit) { response.destroy(); throw new Error('上游响应过大') }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

export async function getText(raw: string | URL, options: NetworkOptions = {}, limit = 4 * 1024 * 1024): Promise<{ text: string; url: URL }> {
  const result = await openPublic(raw, options)
  if ((result.response.statusCode ?? 500) < 200 || (result.response.statusCode ?? 500) >= 300) { result.response.destroy(); throw new Error(`上游服务暂不可用（${result.response.statusCode}）`) }
  const body = await readLimited(result.response, limit)
  return { text: body.toString('utf8').replace(/^\uFEFF/, ''), url: result.url }
}

export class WorkLimiter {
  private active = 0
  private readonly waiting: Array<() => void> = []
  constructor(private readonly capacity: number) {}
  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.capacity) await new Promise<void>(resolve => this.waiting.push(resolve))
    this.active++
    try { return await task() } finally { this.active--; this.waiting.shift()?.() }
  }
}
