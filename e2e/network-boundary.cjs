// Loaded before the production main entry. Only transport destinations change;
// main services, IPC, preload, React components and media decoding remain real.
const http = require('node:http')
const https = require('node:https')
const originalHttp = http.request
const originalHttps = https.request
const fixtureOrigin = process.env.PANDA_E2E_NETWORK_ORIGIN
if (!fixtureOrigin) throw new Error('Missing explicit fixture network origin')
process.env.PANDA_E2E_BOUNDARY_LOADED = 'true'
const local = new URL(fixtureOrigin)
const fixtures = new Set(['m.douban.com', 'movie.douban.com', 'www.douban.com', 'img1.doubanio.com', 'top.baidu.com'])
const allowed = host => fixtures.has(host) || /^[abc]\.(?:catalog|media)\.qa\.example\.org$/.test(host)
function wrap(original) {
  return function request(input, options, callback) {
    if (typeof options === 'function') { callback = options; options = undefined }
    const url = typeof input === 'string' || input instanceof URL ? new URL(input) : null
    const merged = { ...(url ? { protocol: url.protocol, hostname: url.hostname, port: url.port, path: url.pathname + url.search } : input), ...options }
    const host = String(merged.hostname || merged.host || '').split(':')[0]
    if (!allowed(host)) throw new Error(`Fixture requested an unconfigured transport host: ${host}`)
    return originalHttp.call(http, { ...merged, protocol: 'http:', hostname: local.hostname, host: local.hostname,
      port: Number(local.port), agent: undefined, lookup: undefined, localAddress: undefined,
      headers: { ...merged.headers, Host: host } }, callback)
  }
}
http.request = wrap(originalHttp)
https.request = wrap(originalHttps)
const originalFetch = globalThis.fetch
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  if (!allowed(url.hostname)) throw new Error(`Fixture requested an unconfigured fetch host: ${url.hostname}`)
  return originalFetch(new URL(url.pathname + url.search, local), { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), Host: url.hostname } })
}
