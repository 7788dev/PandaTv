import dns from 'node:dns'
import os from 'node:os'
import { isIP, type LookupFunction } from 'node:net'

/**
 * For measurements only: the network interface requests leave by.
 *
 * Behind a tunnelling proxy a development machine measures the proxy's exit, not the line the
 * app is used on. A socket bound to the physical adapter's address leaves by that adapter, and
 * names asked of resolvers over a socket bound the same way get the answers that line gets.
 *
 *   PANDA_DIRECT_EGRESS  the local IPv4 address to bind, or `auto` for the first adapter that is
 *                        not loopback, link-local or a proxy's 198.18/15
 *   PANDA_DIRECT_DNS     the resolvers to ask, comma separated (default: two mainland public ones)
 *
 * Unset, as in every installed copy, nothing here is used.
 */
export interface Egress {
  readonly localAddress: string
  readonly resolvers: readonly string[]
  /** The addresses of a name, as the bound resolvers give them. */
  addresses(hostname: string): Promise<dns.LookupAddress[]>
  /** The same in the shape sockets and http agents take. */
  readonly lookup: LookupFunction
}

type Interfaces = ReturnType<typeof os.networkInterfaces>
const DEFAULT_RESOLVERS = ['223.5.5.5', '119.29.29.29']
const CACHE_ENTRIES = 256

const ipv4 = (interfaces: Interfaces) => Object.values(interfaces).flatMap(rows => rows ?? []).filter(row => row.family === 'IPv4')
const tunnelled = (address: string) => /^198\.1[89]\./.test(address) || address.startsWith('169.254.')

export function createEgress(env: Record<string, string | undefined>, interfaces: Interfaces = os.networkInterfaces()): Egress | undefined {
  const wanted = env.PANDA_DIRECT_EGRESS?.trim()
  if (!wanted) return undefined
  const local = ipv4(interfaces)
  const localAddress = wanted === 'auto' ? local.find(row => !row.internal && !tunnelled(row.address))?.address : wanted
  if (!localAddress || isIP(localAddress) !== 4 || !local.some(row => row.address === localAddress)) throw new Error('PANDA_DIRECT_EGRESS names no local IPv4 address')
  const resolvers = (env.PANDA_DIRECT_DNS ?? '').split(',').map(entry => entry.trim()).filter(Boolean)
  if (!resolvers.length) resolvers.push(...DEFAULT_RESOLVERS)
  if (resolvers.some(entry => isIP(entry.replace(/:\d{1,5}$/, '')) !== 4)) throw new Error('PANDA_DIRECT_DNS takes IPv4 resolvers')

  const resolver = new dns.Resolver({ timeout: 2500, tries: 2 })
  resolver.setServers(resolvers)
  resolver.setLocalAddress(localAddress)
  const cache = new Map<string, { addresses: dns.LookupAddress[]; expires: number }>()
  const flights = new Map<string, Promise<dns.LookupAddress[]>>()

  const addresses = (hostname: string): Promise<dns.LookupAddress[]> => {
    const cached = cache.get(hostname)
    if (cached && cached.expires > Date.now()) return Promise.resolve(cached.addresses)
    const flying = flights.get(hostname)
    if (flying) return flying
    const work = new Promise<dns.LookupAddress[]>((resolve, reject) => resolver.resolve4(hostname, { ttl: true }, (error, rows) => {
      flights.delete(hostname)
      if (error) return reject(error)
      const found = rows.map(row => ({ address: row.address, family: 4 }))
      const ttl = Math.max(5, Math.min(60, ...rows.map(row => row.ttl)))
      if (cache.size >= CACHE_ENTRIES) cache.delete(cache.keys().next().value!)
      cache.set(hostname, { addresses: found, expires: Date.now() + ttl * 1000 })
      resolve(found)
    }))
    flights.set(hostname, work)
    return work
  }

  const lookup: LookupFunction = (hostname, options, callback) => {
    addresses(hostname).then(found => {
      if (!found.length) return callback(Object.assign(new Error(`no address for ${hostname}`), { code: 'ENOTFOUND' }), '', 0)
      if (options.all) return callback(null, found)
      callback(null, found[0]!.address, 4)
    }, error => callback(error as NodeJS.ErrnoException, '', 0))
  }

  return { localAddress, resolvers, addresses, lookup }
}

let current: { value: Egress | undefined } | undefined
/** The egress the environment asks for, read once. */
export const directEgress = (): Egress | undefined => (current ??= { value: createEgress(process.env) }).value

/** For a log line: which route measurements took, without the full local address. */
export const describeEgress = (egress = directEgress()): string => egress
  ? `direct from ${egress.localAddress.replace(/\.\d+$/, '.x')}, names from ${egress.resolvers.join(' ')}`
  : 'system route'
