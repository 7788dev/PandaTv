import type { Playback } from '../../contract/types'

type Marks = Pick<Playback, 'intro' | 'outro'>
const introNames = new Set(['intro', 'opening', 'opening credits', '片头', '片头曲', 'op'])
const outroNames = new Set(['outro', 'credits', 'closing credits', 'end credits', '片尾', '片尾曲', 'ed'])

function kind(value?: string) {
  const label = value?.trim().toLowerCase() ?? ''
  if (introNames.has(label)) return 'intro'
  if (outroNames.has(label)) return 'outro'
}

function dateSeconds(value?: string) {
  if (!value || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) return NaN
  return Date.parse(value) / 1000
}

/** Only an anchored VOD date range can locate a chapter on the playback clock. */
export function hlsChapters(playlist: string): Marks {
  if (!playlist.includes('#EXT-X-DATERANGE:') || !playlist.includes('#EXT-X-ENDLIST')) return {}
  const anchors: { date: number; position: number }[] = []
  const ranges: Map<string, string>[] = []
  let duration = 0
  for (const raw of playlist.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
      const date = dateSeconds(line.slice(line.indexOf(':') + 1))
      if (Number.isFinite(date)) anchors.push({ date, position: duration })
    } else if (line.startsWith('#EXTINF:')) {
      const seconds = Number(line.slice(8).split(',')[0])
      if (!Number.isFinite(seconds) || seconds <= 0) return {}
      duration += seconds
    } else if (line.startsWith('#EXT-X-DATERANGE:')) {
      const attributes = new Map<string, string>()
      for (const field of line.slice(line.indexOf(':') + 1).matchAll(/(?:^|,)([A-Z0-9-]+)=(?:"([^"]*)"|([^,]+))/g)) {
        attributes.set(field[1], field[2] ?? field[3])
      }
      ranges.push(attributes)
    }
  }
  const marks: Marks = {}
  for (const range of ranges) {
    const type = kind(range.get('X-TITLE')) ?? kind(range.get('CLASS')?.split('.').at(-1))
    if (!type) continue
    const date = dateSeconds(range.get('START-DATE'))
    const anchor = anchors.findLast(value => value.date <= date)
    if (!anchor) continue
    const start = date - anchor.date + anchor.position
    if (start < 0 || start >= duration) continue
    const length = range.has('END-DATE') ? dateSeconds(range.get('END-DATE')) - date
      : range.has('DURATION') ? Number(range.get('DURATION')) : undefined
    if (length !== undefined && (!Number.isFinite(length) || length <= 0 || start + length > duration + 0.1)) continue
    if (type === 'intro' && length !== undefined && start + length < duration) marks.intro = { start, end: start + length }
    if (type === 'outro' && start > 0 && (length === undefined || start + length >= duration - 0.1)) marks.outro = start
  }
  if (marks.intro && marks.outro !== undefined && marks.outro < marks.intro.end) delete marks.outro
  return marks
}

/** Read only complete chapter entries within the MP4 prefix already used for admission. */
function childBox(bytes: Buffer, name: string): Buffer | undefined {
  for (let at = 0; at + 8 <= bytes.length;) {
    const shortSize = bytes.readUInt32BE(at)
    const header = shortSize === 1 ? 16 : 8
    if (at + header > bytes.length) return
    const size = shortSize === 1 ? Number(bytes.readBigUInt64BE(at + 8)) : shortSize || bytes.length - at
    if (!Number.isSafeInteger(size) || size < header) return
    if (bytes.toString('ascii', at + 4, at + 8) === name) return bytes.subarray(at + header, at + size)
    at += size
  }
}

export function mp4Chapters(head: Buffer, duration: number | null): Marks {
  if (duration === null || duration <= 0) return {}
  const movie = childBox(head, 'moov')
  const user = movie && childBox(movie, 'udta')
  const chapters = user && childBox(user, 'chpl')
  if (!chapters || chapters.length < 5 || chapters[0] > 1) return {}
  let at = chapters[0] === 1 ? 8 : 4
  if (at >= chapters.length) return {}
  const count = chapters[at++]
  const marks: Marks = {}
  let previous = -1, previousKind: ReturnType<typeof kind>
  for (let index = 0; index < count; index++) {
    if (at + 9 > chapters.length) return {}
    const start = Number(chapters.readBigUInt64BE(at)) / 10_000_000
    const end = at + 9 + chapters[at + 8]
    if (end > chapters.length || start <= previous || start >= duration) return {}
    if (!marks.intro && previousKind === 'intro') marks.intro = { start: previous, end: start }
    previous = start
    previousKind = kind(chapters.toString('utf8', at + 9, end))
    at = end
  }
  if (previousKind === 'outro' && previous > 0) marks.outro = previous
  return marks
}
