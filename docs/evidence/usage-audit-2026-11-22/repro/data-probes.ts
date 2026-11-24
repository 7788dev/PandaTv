import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { DoubanDataSource } from '../../src/main/data/douban'
import { DataError } from '../../src/main/data/http'
import { invokeData, rpc, type Services } from '../../src/main/ipc'
import { ImageCache } from '../../src/main/playback/image-cache'
import { PlaybackService } from '../../src/main/playback/service'
import type { MediaProxy } from '../../src/main/playback/proxy'
import type { SourceRules } from '../../src/main/playback/sources'
import { UserStore } from '../../src/main/state'
import type { Detail } from '../../src/shared/api'

const run = process.argv[2] ?? 'first'
const base = join(process.cwd(), '.tmp', 'usage-audit-2026-11-22')
const temporary = await mkdtemp(join(base, `data-${run}-`))
const observations: Record<string, unknown>[] = []
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const subject = (id: string) => ({ id, title: `Audit title ${id}`, type: 'movie', genres: ['剧情'], year: '2023' })
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })

async function optionalMetadataProbe() {
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  let baseReturned = false, optionalStarted = 0, detailSettled = false, resolverCalls = 0
  const source = new DoubanDataSource({ imageUrl: url => url, onWarning: () => {}, fetch: async raw => {
    const url = String(raw)
    if (/\/(credits|photos)(?:\?|$)/.test(url)) {
      optionalStarted++
      await gate
      return json({}, 403)
    }
    baseReturned = true
    return json(subject('1'))
  } })
  const services = { data: source, playback: { resolve: async () => {
    resolverCalls++
    return { url: 'http://127.0.0.1/audit-observation', format: 'mp4' }
  } }, user: () => new UserStore(join(temporary, 'unused.json')), changed: () => {} } as unknown as Services
  const began = performance.now()
  const detail = source.detail('db-1').then(value => { detailSettled = true; return value })
  const playback = invokeData('data.playback', ['db-1', 1], services)
  await sleep(600)
  const held = { baseReturned, optionalStarted, detailSettled, resolverCalls, elapsedMs: Math.round(performance.now() - began) }
  assert.equal(baseReturned, true)
  assert.equal(optionalStarted, 2)
  assert.equal(detailSettled, false)
  assert.equal(resolverCalls, 0)
  release()
  const item = await detail
  await playback
  assert.equal(item.id, 'db-1')
  assert.equal(resolverCalls, 1)
  observations.push({ scenario: 'optional-metadata-blocks-content-and-playback', held, afterRelease: { detailSettled, resolverCalls, title: item.title, elapsedMs: Math.round(performance.now() - began) }, evidence: 'real DoubanDataSource and invokeData, gated upstream response' })
}

async function libraryFailureProbe() {
  const calls: string[] = []
  const source = new DoubanDataSource({ imageUrl: url => url, onWarning: () => {}, fetch: async raw => {
    const url = new URL(String(raw))
    calls.push(url.pathname)
    if (url.pathname.endsWith('/search/movie')) return json({ items: [subject('1'), subject('2')], total: 2 })
    return json({}, 503)
  } })
  const known = await source.search('审查')
  assert.deepEqual(known.map(item => item.id), ['db-1', 'db-2'])
  let result: Detail[] | undefined
  let error: unknown
  try { result = await source.byIds(['db-1', 'db-3', 'db-2']) } catch (problem) { error = problem }
  assert(error instanceof DataError)
  assert.equal(result, undefined)
  const cachedOnly = await source.byIds(['db-1', 'db-2'])
  assert.equal(cachedOnly.length, 2)
  observations.push({ scenario: 'one-uncached-failure-rejects-cached-library', savedMetadata: known.length, requestedIds: ['db-1', 'db-3', 'db-2'], returnedItems: result?.length ?? 0, errorCode: error.code, unaffectedCacheStillReadable: cachedOnly.length, upstreamPaths: calls })
}

async function librarySerialProbe() {
  class DelayedLibrary extends DoubanDataSource {
    active = 0
    maximum = 0
    requested: string[] = []
    constructor() { super({ imageUrl: url => url }) }
    override async detail(id: string): Promise<Detail> {
      this.requested.push(id)
      this.active++
      this.maximum = Math.max(this.maximum, this.active)
      await sleep(4)
      this.active--
      return { id, title: id, type: 'movie', genres: [], poster: null, backdrop: null }
    }
  }
  const source = new DelayedLibrary()
  const ids = Array.from({ length: 80 }, (_, index) => `db-${index + 1}`)
  let settled = false
  const began = performance.now()
  const pending = source.byIds(ids).then(items => { settled = true; return items })
  await sleep(100)
  const early = { settled, requested: source.requested.length }
  const rows = await pending
  assert.equal(early.settled, false)
  assert.equal(source.maximum, 1)
  assert.deepEqual(rows.map(item => item.id), ids)
  observations.push({ scenario: 'library-is-sequential-with-no-progressive-first-screen', controlledDetailDelayMs: 4, rows: rows.length, maximumConcurrentDetails: source.maximum, after100Ms: early, allItemsReturnedAfterMs: Math.round(performance.now() - began) })
}

async function stateRecoveryProbe() {
  const path = join(temporary, 'broken-user.json')
  await writeFile(path, '{"favorites":["db-1"],"history":[],"searches":[],"settings":', 'utf8')
  const original = await readFile(path, 'utf8')
  const replies = []
  for (let index = 0; index < 3; index++) replies.push(await rpc(() => new UserStore(path).get()))
  assert(replies.every(reply => !reply.ok))
  assert.equal(await readFile(path, 'utf8'), original)
  const shapePath = join(temporary, 'invalid-shape.json')
  await writeFile(shapePath, JSON.stringify({ favorites: null, history: [], searches: [] }), 'utf8')
  const shapeReply = await rpc(() => new UserStore(shapePath).get())
  observations.push({ scenario: 'desktop-corrupt-state-retry-is-not-recovery', repeatedReads: replies, savedFilePreserved: true, invalidShapeReply: shapeReply, evidence: 'real UserStore and RPC with temporary malformed files; app-level gate independently reviewed' })
}

async function diskBudgetProbe() {
  const directory = join(temporary, 'images')
  const cache = new ImageCache(directory, 40 * 1024, 20 * 1024)
  await mkdir(directory)
  await cache.prune()
  const body = Buffer.alloc(16 * 1024, 0)
  body[0] = 0xff; body[1] = 0xd8; body[2] = 0xff
  for (let index = 0; index < 20; index++) await cache.put(`https://img.doubanio.com/audit-${index}.jpg`, body)
  const size = async () => (await Promise.all((await readdir(directory)).map(name => stat(join(directory, name))))).reduce((sum, info) => sum + info.size, 0)
  const before = await size()
  assert.equal(before, 20 * body.length)
  assert(before > 40 * 1024)
  await cache.prune()
  const after = await size()
  assert(after <= 40 * 1024)
  observations.push({ scenario: 'desktop-image-cache-outgrows-budget-after-initial-prune', scaledBudgetBytes: 40 * 1024, bytesAfter20Writes: before, bytesAfterExplicitPrune: after, evidence: 'real ImageCache; byte budget scaled, startup-only scheduling independently reviewed' })
}

async function preferredSourcePrewarmProbe() {
  const makeSource = (key: string, priority: number) => ({ key, name: key, api: `https://${key}.example.com/api`, enabled: true, priority, adPaths: [], fingerprints: [] })
  const sources = [makeSource('old-line', 2), makeSource('picked-line', 1)]
  const rules: SourceRules = { version: 1, verifiedAt: '2026-11-22', maxDropRatio: 0.15, foreignBlockMaxSeconds: 0, sources }
  const service = new PlaybackService({ rules, proxy: {} as MediaProxy, firstSegmentGraceMs: 20, betterPictureMs: 20 })
  const work: Detail = { id: 'db-9', title: 'Audit work', year: 2023, type: 'tv', genres: [], poster: null, backdrop: null }
  const probes: Array<{ source: string; url: string }> = []
  const candidates = sources.map(source => ({ source, vodId: source.key, dubbed: false, weak: false, lines: [{ name: source.key, episodes: [1, 2, 3].map(number => ({ number, title: `第${number}集`, url: `https://${source.key}.example.com/${number}.mp4`, format: 'mp4' })) }] }))
  // Keep real source ordering, episode alignment, preference updates and resolved cache;
  // only the external catalogue and media byte acquisition are deterministic seams.
  const seams = service as unknown as { candidates: () => Promise<unknown>; probe: (episode: { url: string }, source: { key: string }) => Promise<unknown> }
  seams.candidates = async () => candidates
  seams.probe = async (episode, source) => {
    probes.push({ source: source.key, url: episode.url })
    return { playback: { url: episode.url, format: 'mp4' }, whole: Promise.resolve(), shown: '1080P', margin: () => 10, received: () => 1024 }
  }
  await service.resolve(work, 1)
  const prepared = await service.resolve(work, 2)
  const picked = await service.resolve(work, 1, undefined, false, {}, 'picked-line')
  const beforeNextProbes = probes.length
  const next = await service.resolve(work, 2)
  const cachedPathMadeNewProbes = probes.length !== beforeNextProbes
  const freshEpisode = await service.resolve(work, 3)
  assert(picked.url.includes('picked-line'))
  assert(prepared.url.includes('old-line'))
  assert.equal(next.url, prepared.url)
  assert.equal(cachedPathMadeNewProbes, false)
  assert(freshEpisode.url.includes('picked-line'))
  observations.push({ scenario: 'manual-line-choice-does-not-invalidate-prepared-next-episode', preparedNextEpisodeUrl: prepared.url, manuallyPickedEpisodeUrl: picked.url, actualNextEpisodeUrl: next.url, freshEpisodeUrl: freshEpisode.url, cachedPathMadeNewProbes, evidence: 'real PlaybackService resolve/choose/attempts/cache with deterministic catalogue and media seams; no live handoff claim' })
}

await optionalMetadataProbe()
await libraryFailureProbe()
await librarySerialProbe()
await stateRecoveryProbe()
await diskBudgetProbe()
await preferredSourcePrewarmProbe()
const report = { at: new Date().toISOString(), run, workspaceSource: true, scenarios: observations }
await writeFile(join(base, `data-probes-${run}.json`), JSON.stringify(report, null, 2), 'utf8')
console.log(JSON.stringify(report, null, 2))
