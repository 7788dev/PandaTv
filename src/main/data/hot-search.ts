import { DataError } from './http'
import { list, positive, row, text } from './normalize'

export interface HotQuery { title: string; score: number }

/** Baidu's film/TV search chart, not a film-rating or social-topic chart. */
export function hotQueries(raw: unknown, board: 'movie' | 'teleplay'): HotQuery[] {
  const root = row(raw), data = row(root.data)
  if (root.success !== true || !Array.isArray(data.cards)) throw new DataError('INVALID_RESPONSE', 'Invalid hot-search response')
  const entries = list(data.cards).flatMap(card => row(card).component === 'tabImgInfoList' ? list(row(card).content).flatMap(group => list(row(group).content)) : [])
  const result = entries.flatMap(entry => {
    const value = row(entry), heat = row(value.hotScore)
    const title = text(value.title), score = positive(heat.value)
    if (value.Sa !== 'fyb_' + board || !title || title.length > 100 || !score || heat.desc !== '热搜指数') return []
    return [{ title, score }]
  })
  if (!result.length) throw new DataError('INVALID_RESPONSE', 'No verified movie search queries')
  return result
}
export function combineHotQueries(boards: HotQuery[][]): string[] {
  const seen = new Set<string>()
  return boards.flat().sort((a, b) => b.score - a.score).filter(entry => {
    if (seen.has(entry.title)) return false
    seen.add(entry.title); return true
  }).slice(0, 10).map(entry => entry.title)
}
