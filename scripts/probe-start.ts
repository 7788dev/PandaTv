// The app's own start of playback, on the machine this runs on: for the popular titles of every
// channel, the catalogue search, the choice of a source for episode 1, the served manifest and
// its first segment and one from the middle; which source won, with what picture, and which
// sources failed, with reasons. One PlaybackService for the whole run, as in the app.
//   npm run probe:start -- [titlesPerChannel=4] [sorts=hot] [onlyTheseSources]
// The bundle (.tmp/probe-start.cjs) is self-contained: to measure another network, pipe it to
// `node - 8 hot` on a machine there (Node 22+); nothing is installed or written on that machine.
// On a machine behind a proxy, PANDA_DIRECT_EGRESS=auto measures the line itself (src/main/egress.ts);
// PANDA_SOURCE_CONFIG measures another set of sources.
import { DoubanDataSource } from '../src/main/data/douban'
import { PlaybackService } from '../src/main/playback/service'
import { MediaProxy } from '../src/main/playback/proxy'
import { loadSourceRules } from '../src/main/playback/sources'
import { createTransport } from '../src/main/data/transport'
import { describeEgress } from '../src/main/egress'

async function main() {
  const perChannel = Number(process.argv[2] ?? 4)
  const sorts = (process.argv[3] ?? 'hot').split(',')
  const only = process.argv[4]?.split(',')
  const rules = loadSourceRules()
  console.log(JSON.stringify({ route: describeEgress(), sources: rules.sources.filter(source => source.enabled).map(source => source.key).join(',') }))
  if (only) for (const source of rules.sources) source.enabled = only.includes(source.key)
  const data = new DoubanDataSource({ imageUrl: url => url, onWarning: () => {}, fetch: createTransport() })
  const proxy = new MediaProxy({ rules }); await proxy.start()
  const rows: Record<string, number | string>[] = []
  const wins: Record<string, number> = {}, fails: Record<string, number> = {}
  const seen = new Set<string>()
  // One service for the whole run, as in the app: what it learns of a source carries over.
  let failures: string[] = []
  const playback = new PlaybackService({ proxy, rules, onSourceFailure: (source, reason, ms) => { failures.push(`${source} ${reason} ${ms}ms`); fails[source] = (fails[source] ?? 0) + 1 } })
  for (const type of ['tv', 'anime', 'movie', 'variety'] as const) for (const sort of sorts) {
    let page
    try { page = await data.channel(type, { sort } as never) } catch (error) { console.log(JSON.stringify({ type, sort, channelError: (error as Error).message })); continue }
    for (const card of page.items.filter(entry => !seen.has(entry.id)).slice(0, perChannel)) {
      seen.add(card.id)
      failures = []
      const row: Record<string, number | string> = { type, sort, title: card.title }
      try {
        let t = Date.now()
        const item = await data.detail(card.id); row.detail = Date.now() - t
        const record = data.getMetadata(item.id)
        const hints = { single: record?.kind === 'movie', aliases: record?.aliases, totalEpisodes: record?.totalEpisodes }
        t = Date.now(); await playback.availability(item, hints); row.search = Date.now() - t
        row.present = (await playback.sources(item, 1, hints)).list.map(entry => entry.key).join(',')
        row.behind = [...new Set([...(playback as unknown as { behind: Map<string, number> }).behind.keys()].map(key => key.slice(key.lastIndexOf(':') + 1)))].join(',')
        t = Date.now(); const played = await playback.resolve(item, 1, undefined, false, hints); row.resolve = Date.now() - t
        const lines = await playback.sources(item, 1, hints)
        row.won = lines.current ?? '?'; row.carriedBy = lines.list.map(entry => entry.key).join(',')
        wins[String(row.won)] = (wins[String(row.won)] ?? 0) + 1
        row.quality = String(played.quality ?? ''); row.removed = String((played as { removedSeconds?: number }).removedSeconds ?? '')
        t = Date.now(); const text = await (await fetch(played.url, { signal: AbortSignal.timeout(20000) })).text(); row.manifest = Date.now() - t
        const first = text.split('\n').find(line => line.startsWith('http'))
        if (first) { t = Date.now(); const bytes = (await (await fetch(first, { signal: AbortSignal.timeout(20000) })).arrayBuffer()).byteLength; row.segment = Date.now() - t; row.segmentKB = Math.round(bytes / 1024) }
        // A segment from further in, the way a seek or steady playback asks for it.
        const all = text.split('\n').filter(line => line.startsWith('http'))
        if (all.length > 20) { t = Date.now(); const bytes = (await (await fetch(all[Math.floor(all.length / 2)]!, { signal: AbortSignal.timeout(20000) })).arrayBuffer()).byteLength; row.midMs = Date.now() - t; row.midKB = Math.round(bytes / 1024) }
        row.total = Number(row.search) + Number(row.resolve) + Number(row.manifest) + Number(row.segment ?? 0)
      } catch (error) { row.error = (error as Error).message }
      if (failures.length) row.failures = failures.join(' | ')
      rows.push(row)
      console.log(JSON.stringify(row))
    }
  }
  const ok = rows.filter(row => typeof row.total === 'number')
  const median = (key: string) => { const values = ok.map(row => Number(row[key])).filter(Number.isFinite).sort((a, b) => a - b); return values[Math.floor(values.length / 2)] }
  console.log(JSON.stringify({ at: new Date().toISOString(), titles: rows.length, ok: ok.length, median: { search: median('search'), resolve: median('resolve'), manifest: median('manifest'), segment: median('segment'), mid: median('midMs'), total: median('total') }, worstTotal: Math.max(...ok.map(row => Number(row.total))), wins, fails }))
  process.exit(0)
}
void main()
