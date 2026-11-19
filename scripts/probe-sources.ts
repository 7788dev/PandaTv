/**
 * Replays the metadata → play source chain against the live services, the way the app does it:
 * Douban detail (with aliases and episode count) → matching source records → episode 1 resolved
 * and its first media bytes read.
 *
 *   npm run probe:sources            hot titles of every channel + the split serials below
 *   npm run probe:sources -- 12      the same with 12 hot titles per channel
 *   npm run probe:sources -- 14 docs/evidence/source-run.json  preserve older evidence
 *
 * Writes docs/evidence/source-coverage.json. Nothing here is shipped.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DoubanDataSource } from '../src/main/data/douban'
import { PlaybackService } from '../src/main/playback/service'
import { MediaProxy } from '../src/main/playback/proxy'
import type { MediaItem, MediaType } from '../design/contract/types'

/** Long serials Douban files as one subject per run; play sources keep one cumulative record. */
const SERIALS = ['凡人修仙传', '斗破苍穹', '斗罗大陆', '完美世界', '吞噬星空', '仙逆']
const TYPES: MediaType[] = ['tv', 'movie', 'anime', 'variety', 'doc']

interface Row {
  group: string; id: string; title: string; year?: number; type: MediaType
  doubanEpisodes?: number; runs?: string[]
  ok: boolean; sourceEpisodes?: number; format?: string; quality?: string; ms: number; error?: string
}

async function main() {
  const perChannel = Number(process.argv[2] ?? 14)
  const data = new DoubanDataSource({ imageUrl: url => url, onWarning: () => {} })
  const proxy = new MediaProxy(); await proxy.start()
  const playback = new PlaybackService({ proxy })
  const rows: Row[] = []

  const check = async (group: string, card: MediaItem) => {
    const started = Date.now()
    const row: Row = { group, id: card.id, title: card.title, year: card.year, type: card.type, ok: false, ms: 0 }
    try {
      const item = await data.detail(card.id)
      const record = data.getMetadata(item.id)
      const hints = { single: record?.kind === 'movie', aliases: record?.aliases, totalEpisodes: record?.totalEpisodes }
      row.title = item.title; row.year = item.year; row.type = item.type
      if (record?.totalEpisodes) row.doubanEpisodes = record.totalEpisodes
      const runs = (record?.aliases ?? []).filter(alias => /\d+\s*[-—~～]\s*\d+\s*[集话]$/.test(alias))
      if (runs.length) row.runs = runs
      const availability = await playback.availability(item, hints)
      const played = await playback.resolve(item, 1, undefined, false, hints)
      Object.assign(row, { ok: true, sourceEpisodes: availability.episodes ?? 1, format: played.format, ...(played.quality ? { quality: played.quality } : {}) })
    } catch (error) { row.error = (error as Error).message }
    row.ms = Date.now() - started
    rows.push(row)
    console.log(`${row.ok ? 'ok  ' : 'MISS'} ${group} ${row.type} ${row.title} ${row.year ?? ''} 豆瓣${row.doubanEpisodes ?? '-'}集 ${row.ok ? `片源${row.sourceEpisodes}集 ${row.format} ${row.quality ?? ''}` : row.error} ${row.ms}ms${row.runs ? ' | ' + row.runs.join(' ; ') : ''}`)
  }

  for (const type of TYPES) {
    const page = await data.channel(type, { sort: 'hot' })
    for (const card of page.items.slice(0, perChannel)) await check(`hot:${type}`, card)
  }
  for (const term of SERIALS) {
    const found = (await data.search(term)).filter(item => item.title.includes(term)).slice(0, 8)
    for (const card of found) await check(`serial:${term}`, card)
  }

  const summary: Record<string, string> = {}
  for (const group of [...new Set(rows.map(row => row.group.startsWith('serial:') ? 'serials' : row.group))]) {
    const part = rows.filter(row => (row.group.startsWith('serial:') ? 'serials' : row.group) === group)
    summary[group] = `${part.filter(row => row.ok).length}/${part.length}`
  }
  const runs = rows.filter(row => row.runs)
  summary['serials with an episode range'] = `${runs.filter(row => row.ok).length}/${runs.length}`
  const out = process.argv[3] ?? join(__dirname, '..', 'docs', 'evidence', 'source-coverage.json')
  writeFileSync(out, JSON.stringify({
    at: new Date().toISOString(),
    method: 'DoubanDataSource.detail → PlaybackService.availability + resolve(episode 1); ok = first media bytes read',
    perChannel, summary, rows,
  }, null, 1) + '\n')
  console.log('\n' + JSON.stringify(summary))
  await proxy.close(); process.exit(0)
}
void main()
