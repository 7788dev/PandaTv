// Probes every channel filter through the production data source against live Douban.
// Usage: npm run probe:filters [-- <out.json> <types|all> <dimensions>]   (default: everything, to docs/evidence/filter-vocabulary.json)
// A term "passes" when the first page the app would show contains at least MIN titles.
// A request that errors is asked once more at the end, as the app's retry button would; the
// first error stays on the row (firstError) so upstream slowness is counted, not hidden.
import { writeFileSync } from 'node:fs'
import { DoubanDataSource } from '../src/main/data/douban'
import type { ChannelQuery, MediaType } from '../src/contract/types'

const MIN = 6
const TYPES: MediaType[] = ['tv', 'movie', 'anime', 'variety', 'doc']
type Dimension = 'genre' | 'region' | 'year'
interface Row { type: MediaType; dimension: Dimension; term: string; count: number; more: boolean; sample: string[]; error?: string; firstError?: string }

async function main() {
  const out = process.argv[2] ?? 'docs/evidence/filter-vocabulary.json'
  const only = process.argv[3] && process.argv[3] !== 'all' ? process.argv[3].split(',') as MediaType[] : undefined
  const dimensions = process.argv[4]?.split(',') as Dimension[] | undefined
  const data = new DoubanDataSource({ imageUrl: url => url, onWarning: () => {} })
  const rows: Row[] = []
  for (const type of only ?? TYPES) {
    const filters = await data.filters(type)
    const plan: Array<[Dimension, string[]]> = [['genre', filters.genres], ['region', filters.regions], ['year', filters.years]]
    for (const [dimension, terms] of plan) for (const term of dimensions && !dimensions.includes(dimension) ? [] : terms) {
      const query: ChannelQuery = { sort: 'hot', [dimension]: term }
      const row: Row = { type, dimension, term, count: 0, more: false, sample: [] }
      try {
        const page = await data.channel(type, query)
        row.count = page.items.length; row.more = page.next !== null
        row.sample = page.items.slice(0, 3).map(item => `${item.title}(${item.year ?? ''})`)
      } catch (error) { row.error = error instanceof Error ? error.message : String(error) }
      rows.push(row)
      console.log(`${row.error ? 'ERR ' : row.count >= MIN ? 'ok  ' : 'LOW '} ${type} ${dimension} ${term} ${row.count}${row.more ? '+' : ''} ${row.error ?? row.sample.join('、')}`)
    }
  }
  for (const row of rows.filter(row => row.error)) {
    row.firstError = row.error; delete row.error
    try {
      const page = await data.channel(row.type, { sort: 'hot', [row.dimension]: row.term })
      row.count = page.items.length; row.more = page.next !== null
      row.sample = page.items.slice(0, 3).map(item => `${item.title}(${item.year ?? ''})`)
    } catch (error) { row.error = error instanceof Error ? error.message : String(error) }
    console.log(`${row.error ? 'ERR ' : row.count >= MIN ? 'ok  ' : 'LOW '} ${row.type} ${row.dimension} ${row.term} ${row.count}${row.more ? '+' : ''} (asked again after: ${row.firstError}) ${row.error ?? ''}`)
  }
  const failing = rows.filter(row => row.error || row.count < MIN)
  writeFileSync(out, JSON.stringify({
    at: new Date().toISOString(),
    method: `DoubanDataSource.channel(type, { sort: 'hot', [dimension]: term }) first page; pass = at least ${MIN} titles`,
    total: rows.length, failing: failing.length, askedAgain: rows.filter(row => row.firstError).length, rows,
  }, null, 1) + '\n')
  console.log(`\n${rows.length} filters probed, ${failing.length} below ${MIN} titles`)
  for (const row of failing) console.log(`  ${row.type} ${row.dimension} ${row.term}: ${row.error ?? row.count}`)
  process.exit(failing.length ? 1 : 0)
}
void main()
