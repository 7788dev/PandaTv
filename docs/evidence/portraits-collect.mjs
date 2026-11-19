// A sample of the portraits the detail page shows, to measure where faces sit in them (portraits-measure.py).
// Titles come from the collections the home page reads plus the top list; for each title the principal
// credits; for each person with a real photo the address the application uses (avatar.normal first).
// usage: node docs/evidence/portraits-collect.mjs <out dir>   (a new, empty directory outside the repository's sources)
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const out = process.argv[2]
if (!out) throw new Error('usage: collect-portraits.mjs <out dir>')
const BASE = 'https://m.douban.com/rexxar/api/v2'
const headers = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Referer: 'https://m.douban.com/', Accept: 'application/json',
}
const get = async path => {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(BASE + path, { headers, redirect: 'manual', signal: AbortSignal.timeout(20000) })
      if (response.status === 200) return await response.json()
    } catch { /* try again */ }
  }
  return null
}
const portrait = value => {
  if (typeof value !== 'string') return null
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname.endsWith('doubanio.com') && url.pathname.startsWith('/view/') ? url.href : null } catch { return null }
}

await mkdir(out, { recursive: true })
const titles = new Map()
for (const collection of ['movie_real_time_hotest', 'tv_hot', 'tv_animation', 'movie_latest', 'movie_top250', 'show_hot', 'tv_domestic', 'tv_american', 'tv_korean', 'tv_japanese']) {
  const answer = await get(`/subject_collection/${collection}/items?start=0&count=20`)
  const items = answer?.subject_collection_items ?? []
  for (const item of items) if ((item.type === 'movie' || item.type === 'tv') && /^\d+$/.test(String(item.id))) titles.set(String(item.id), item.type)
  console.log(collection, items.length, 'titles so far', titles.size)
}
const people = new Map()
let rows = 0, silhouettes = 0, failedTitles = 0
for (const [id, kind] of titles) {
  const credits = await get(`/${kind}/${id}/credits`)
  if (!credits?.items) { failedTitles++; continue }
  for (const person of credits.items.slice(0, 8)) {
    rows++
    const url = portrait(person.avatar?.normal) ?? portrait(person.avatar?.large)
    if (!url) { silhouettes++; continue }
    const key = String(person.id)
    if (!people.has(key)) people.set(key, { id: key, name: person.name, category: person.category, url })
  }
}
console.log('titles', titles.size, 'without credits', failedTitles, 'rows', rows, 'without a photo', silhouettes, 'distinct people with a photo', people.size)
const index = []
let failed = 0
const queue = [...people.values()]
await Promise.all(Array.from({ length: 6 }, async () => {
  for (let person = queue.pop(); person; person = queue.pop()) {
    try {
      const response = await fetch(person.url, { headers: { 'User-Agent': headers['User-Agent'], Referer: 'https://m.douban.com/' }, signal: AbortSignal.timeout(25000) })
      if (response.status !== 200) { failed++; continue }
      const file = `${person.id}.jpg`
      await writeFile(join(out, file), Buffer.from(await response.arrayBuffer()))
      index.push({ ...person, file })
    } catch { failed++ }
  }
}))
await writeFile(join(out, 'index.json'), JSON.stringify({ at: new Date().toISOString(), titles: titles.size, rows, silhouettes, people: index }, null, 1))
console.log('downloaded', index.length, 'failed', failed)
