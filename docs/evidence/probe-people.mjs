// Replayable: node docs/evidence/probe-people.mjs  ->  docs/evidence/people-audit.json
// What Douban answers about the people of a title (the short principal list against the full one) and about
// one person's works. Read-only, no credentials. Only counts, timings and identifiers are kept.
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const BASE = 'https://m.douban.com/rexxar/api/v2'
const headers = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Referer: 'https://m.douban.com/', Accept: 'application/json',
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const get = async path => {
  const started = Date.now()
  try {
    const response = await fetch(BASE + path, { headers, redirect: 'manual', signal: AbortSignal.timeout(30000) })
    const text = await response.text()
    let body = {}
    try { body = JSON.parse(text) } catch { /* not JSON */ }
    return { status: response.status, ms: Date.now() - started, body }
  } catch (error) { return { status: 0, ms: Date.now() - started, body: {}, error: String(error) } }
}
const median = values => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null }
const photo = value => { try { const url = new URL(value); return url.protocol === 'https:' && url.hostname.endsWith('doubanio.com') && url.pathname.startsWith('/view/') } catch { return false } }

const out = { at: new Date().toISOString(), titles: [], people: [] }

// Five titles from each of nine collections.
const titles = new Map()
for (const collection of ['movie_real_time_hotest', 'tv_hot', 'tv_animation', 'movie_latest', 'movie_top250', 'show_hot', 'tv_domestic', 'tv_american', 'tv_korean']) {
  const answer = await get(`/subject_collection/${collection}/items?start=0&count=12`)
  let taken = 0
  for (const item of answer.body.subject_collection_items ?? []) {
    if (taken === 5) break
    if ((item.type !== 'movie' && item.type !== 'tv') || titles.has(String(item.id))) continue
    titles.set(String(item.id), item.type); taken++
  }
}
for (const [id, kind] of titles) {
  const credits = await get(`/${kind}/${id}/credits`)
  const rows = credits.body.items ?? []
  const full = []
  for (let read = 0; read < 2; read++) {
    const answer = await get(`/${kind}/${id}/celebrities`)
    full.push({ status: answer.status, ms: answer.ms, people: (answer.body.directors ?? []).length + (answer.body.actors ?? []).length, ids: [...(answer.body.directors ?? []), ...(answer.body.actors ?? [])].map(person => person.id).join(',') })
    await wait(250)
  }
  out.titles.push({
    id, kind,
    credits: { status: credits.status, ms: credits.ms, rows: rows.length, total: credits.body.total ?? null, distinct: new Set(rows.map(row => row.id)).size, withPhoto: rows.filter(row => photo(row.avatar?.normal) || photo(row.avatar?.large)).length, categories: rows.map(row => row.category) },
    celebrities: { reads: full.map(({ status, ms, people }) => ({ status, ms, people })), sameBothReads: full[0].ids === full[1].ids },
  })
  await wait(250)
}

// Three people with long lists, read the way the application reads them: 30 at a time, a short page read again once.
const PAGE = 30
for (const id of ['1274242', '1054424', '1313742']) {
  const profile = await get(`/celebrity/${id}`)
  const ranges = [], ids = []
  let total = null
  for (let start = 0; total === null || start < total; start += PAGE) {
    let answer = await get(`/celebrity/${id}/works?start=${start}&count=${PAGE}`)
    if (total === null) total = answer.body.total ?? 0
    const expected = Math.min(PAGE, total - start)
    const first = { got: (answer.body.works ?? []).length, ms: answer.ms, status: answer.status }
    let again = null
    if (first.got < expected) {
      await wait(900)
      answer = await get(`/celebrity/${id}/works?start=${start}&count=${PAGE}`)
      again = { got: (answer.body.works ?? []).length, ms: answer.ms, status: answer.status }
    }
    ranges.push({ start, expected, first, ...(again ? { again } : {}) })
    for (const entry of answer.body.works ?? []) ids.push(String(entry.work?.id))
    if (!total) break
    await wait(250)
  }
  out.people.push({ id, profile: { status: profile.status, ms: profile.ms, named: typeof profile.body.title === 'string', photo: photo(profile.body.cover?.normal?.url) || photo(profile.body.cover?.large?.url) }, total, listed: ids.length, distinct: new Set(ids).size, ranges })
}
const missing = await get('/celebrity/9999999999')
out.missing = { status: missing.status, code: missing.body.code ?? null, msg: missing.body.msg ?? null }

// A short page is split into smaller ones: is the list the same list at every page size?
const SAME = 60
const sizes = {}
for (const size of [30, 10, 5]) {
  const ids = []
  let rereads = 0
  for (let start = 0; start < SAME; start += size) {
    let answer = await get(`/celebrity/1313742/works?start=${start}&count=${size}`)
    for (let tries = 0; (answer.body.works ?? []).length < size && tries < 3; tries++) { rereads++; await wait(900); answer = await get(`/celebrity/1313742/works?start=${start}&count=${size}`) }
    for (const entry of answer.body.works ?? []) ids.push(String(entry.work?.id))
    await wait(200)
  }
  sizes[size] = { ids: ids.join(','), listed: ids.length, rereads }
}
out.pageSizes = { person: '1313742', first: SAME, listed: Object.fromEntries(Object.entries(sizes).map(([size, value]) => [size, value.listed])), rereads: Object.fromEntries(Object.entries(sizes).map(([size, value]) => [size, value.rereads])), sameOrder: sizes[30].ids === sizes[10].ids && sizes[10].ids === sizes[5].ids }

const answered = out.titles.filter(title => title.credits.status === 200)
out.summary = {
  titles: out.titles.length,
  credits: {
    answered: answered.length,
    rows: { least: Math.min(...answered.map(title => title.credits.rows)), most: Math.max(...answered.map(title => title.credits.rows)) },
    ms: { median: median(answered.map(title => title.credits.ms)), worst: Math.max(...answered.map(title => title.credits.ms)) },
    rowsInAll: answered.reduce((sum, title) => sum + title.credits.rows, 0),
    withPhoto: answered.reduce((sum, title) => sum + title.credits.withPhoto, 0),
    actorsMost: Math.max(...answered.map(title => title.credits.categories.filter(category => category === '演员').length)),
    samePersonTwice: answered.filter(title => title.credits.distinct < title.credits.rows).length,
    creditedInAllMost: Math.max(...answered.map(title => title.credits.total ?? 0)),
  },
  celebrities: {
    people: { least: Math.min(...out.titles.flatMap(title => title.celebrities.reads.filter(read => read.status === 200).map(read => read.people))), most: Math.max(...out.titles.flatMap(title => title.celebrities.reads.map(read => read.people))) },
    differentOnSecondRead: out.titles.filter(title => !title.celebrities.sameBothReads).length,
    failedReads: out.titles.flatMap(title => title.celebrities.reads).filter(read => read.status !== 200).length,
    ms: { median: median(out.titles.flatMap(title => title.celebrities.reads.map(read => read.ms))), worst: Math.max(...out.titles.flatMap(title => title.celebrities.reads.map(read => read.ms))) },
  },
  works: out.people.map(person => ({ id: person.id, total: person.total, listed: person.listed, distinct: person.distinct, firstPageMs: person.ranges[0]?.first.ms, ranges: person.ranges.length, shortAtFirst: person.ranges.filter(range => range.again).length, stillShort: person.ranges.filter(range => range.again && range.again.got < range.expected).length })),
}
await writeFile(fileURLToPath(new URL('./people-audit.json', import.meta.url)), JSON.stringify(out, null, 1))
console.log(JSON.stringify(out.summary, null, 1))
console.log('missing person', JSON.stringify(out.missing))
console.log('page sizes', JSON.stringify(out.pageSizes))
