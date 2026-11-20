import dgram from 'node:dgram'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, expect, it } from 'vitest'
import { createEgress, describeEgress } from '../src/main/egress'

const closers: Array<() => void> = []
afterEach(() => { for (const close of closers.splice(0)) close() })

const loopback = { lo: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4' as const, mac: '00:00:00:00:00:00', internal: true, cidr: '127.0.0.1/8' }] }
const adapter = (address: string, internal = false) => ({ address, netmask: '255.255.255.0', family: 'IPv4' as const, mac: '00:00:00:00:00:01', internal, cidr: `${address}/24` })

/** A resolver on loopback that answers every A question with `answers`, and counts the questions. */
async function resolver(answers: Record<string, { addresses: string[]; ttl: number }>) {
  const asked: string[] = []
  const server = dgram.createSocket('udp4')
  server.on('message', (query, from) => {
    let at = 12; const labels: string[] = []
    while (query[at]) { labels.push(query.subarray(at + 1, at + 1 + query[at]!).toString('ascii')); at += query[at]! + 1 }
    const question = query.subarray(12, at + 5)
    const name = labels.join('.')
    asked.push(name)
    const found = answers[name]
    const header = Buffer.alloc(12)
    query.copy(header, 0, 0, 2)
    header.writeUInt16BE(found ? 0x8180 : 0x8183, 2)
    header.writeUInt16BE(1, 4)
    header.writeUInt16BE(found?.addresses.length ?? 0, 6)
    const records = (found?.addresses ?? []).map(address => {
      const record = Buffer.alloc(16)
      record.writeUInt16BE(0xc00c, 0); record.writeUInt16BE(1, 2); record.writeUInt16BE(1, 4); record.writeUInt32BE(found!.ttl, 6); record.writeUInt16BE(4, 10)
      address.split('.').forEach((part, i) => record.writeUInt8(Number(part), 12 + i))
      return record
    })
    server.send(Buffer.concat([header, question, ...records]), from.port, from.address)
  })
  await new Promise<void>(resolve => server.bind(0, '127.0.0.1', resolve))
  closers.push(() => server.close())
  return { asked, address: `127.0.0.1:${server.address().port}` }
}

it('is off unless the environment names an adapter', () => {
  expect(createEgress({})).toBeUndefined()
  expect(createEgress({ PANDA_DIRECT_EGRESS: ' ' })).toBeUndefined()
  expect(describeEgress(undefined)).toBe('system route')
})

it('picks the first adapter that is not loopback, link-local or a proxy tunnel', () => {
  const interfaces = { lo: loopback.lo, tun: [adapter('198.18.0.1')], idle: [adapter('169.254.28.7')], wlan: [adapter('192.168.5.20')], lan: [adapter('10.0.0.8')] }
  const egress = createEgress({ PANDA_DIRECT_EGRESS: 'auto' }, interfaces)!
  expect(egress.localAddress).toBe('192.168.5.20')
  expect(egress.resolvers).toEqual(['223.5.5.5', '119.29.29.29'])
  expect(describeEgress(egress)).toBe('direct from 192.168.5.x, names from 223.5.5.5 119.29.29.29')
})

it('refuses an address this machine does not have, and resolvers that are not addresses', () => {
  const interfaces = { lo: loopback.lo, wlan: [adapter('192.168.5.20')] }
  expect(() => createEgress({ PANDA_DIRECT_EGRESS: '192.168.5.21' }, interfaces)).toThrow('PANDA_DIRECT_EGRESS')
  expect(() => createEgress({ PANDA_DIRECT_EGRESS: 'wlan' }, interfaces)).toThrow('PANDA_DIRECT_EGRESS')
  expect(() => createEgress({ PANDA_DIRECT_EGRESS: 'auto' }, { lo: loopback.lo, tun: [adapter('198.18.0.1')] })).toThrow('PANDA_DIRECT_EGRESS')
  expect(() => createEgress({ PANDA_DIRECT_EGRESS: '192.168.5.20', PANDA_DIRECT_DNS: 'dns.example' }, interfaces)).toThrow('PANDA_DIRECT_DNS')
})

it('asks its own resolvers, once per name while the answer is fresh', async () => {
  const dns = await resolver({ 'catalogue.example': { addresses: ['45.253.16.17', '45.253.16.18'], ttl: 30 } })
  const egress = createEgress({ PANDA_DIRECT_EGRESS: '127.0.0.1', PANDA_DIRECT_DNS: dns.address }, loopback)!
  const [first, second] = await Promise.all([egress.addresses('catalogue.example'), egress.addresses('catalogue.example')])
  expect(first).toEqual([{ address: '45.253.16.17', family: 4 }, { address: '45.253.16.18', family: 4 }])
  expect(second).toBe(first)
  expect(await egress.addresses('catalogue.example')).toBe(first)
  expect(dns.asked).toEqual(['catalogue.example'])
  await expect(egress.addresses('missing.example')).rejects.toMatchObject({ code: 'ENOTFOUND' })
})

it('gives sockets one address or all of them, and connects from the bound address', async () => {
  const seen: Array<string | undefined> = []
  const server = http.createServer((request, response) => { seen.push(request.socket.remoteAddress); response.end('ok') })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  closers.push(() => server.close())
  const dns = await resolver({ 'media.example': { addresses: ['127.0.0.1'], ttl: 30 } })
  const egress = createEgress({ PANDA_DIRECT_EGRESS: '127.0.0.1', PANDA_DIRECT_DNS: dns.address }, loopback)!
  const one = await new Promise(resolve => egress.lookup('media.example', {}, (_error, address, family) => resolve([address, family])))
  expect(one).toEqual(['127.0.0.1', 4])
  const all = await new Promise(resolve => egress.lookup('media.example', { all: true }, (_error, addresses) => resolve(addresses)))
  expect(all).toEqual([{ address: '127.0.0.1', family: 4 }])
  const agent = new http.Agent({ localAddress: egress.localAddress, lookup: egress.lookup })
  closers.push(() => agent.destroy())
  const body = await new Promise<string>((resolve, reject) => {
    http.get({ host: 'media.example', port: (server.address() as AddressInfo).port, agent }, response => {
      let text = ''; response.setEncoding('utf8').on('data', chunk => { text += chunk }).on('end', () => resolve(text))
    }).on('error', reject)
  })
  expect(body).toBe('ok')
  expect(seen).toEqual(['127.0.0.1'])
})
