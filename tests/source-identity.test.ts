import { expect, it } from 'vitest'
import type { MediaItem } from '../src/contract/types'
import { matchRecord, numbering, parseLines, referenceLine } from '../src/main/playback/service'

const item: MediaItem = { id: 'db-26647087', title: '三体', year: 2023, region: '中国大陆', type: 'tv', genres: [], poster: null, backdrop: null }
const raw = { vod_name: '三体第一季', vod_year: '2023–', type_name: '欧美剧', vod_area: '美国' }

it('rejects another regional adaptation even when its title, season and misreported year match', () => {
  expect(matchRecord(item, raw)).toBeUndefined()
  expect(matchRecord(item, { ...raw, vod_year: '2024' })).toBeUndefined()
  expect(matchRecord(item, { ...raw, vod_name: '三体', type_name: '国产剧', vod_area: '内地' })).toEqual({})
})

it('retains coproductions, common country aliases and missing or unrecognized country metadata', () => {
  expect(matchRecord({ ...item, region: '中国大陆 / 中国香港' }, { ...raw, vod_area: '香港' })).toEqual({})
  expect(matchRecord(item, { ...raw, vod_area: '中国台湾 / 中国大陆' })).toEqual({})
  for (const vod_area of [undefined, '', '未知', '欧美']) expect(matchRecord(item, { ...raw, vod_area })).toEqual({})
  expect(matchRecord({ ...item, region: undefined }, raw)).toEqual({})
})

it('maps merged mirrors to the correct numbered programme and retains every distinct same-episode address', () => {
  const entries = ['彩蛋1$https://media.example.org/bonus.mp4', '幕后$https://media.example.org/behind.mp4',
    '第01集$https://media.example.org/a-1.mp4', '第01集$https://media.example.org/a-1.mp4',
    '第01集$https://media.example.org/b-1.mp4', '第02集$https://media.example.org/a-2.mp4',
    '第02集$https://media.example.org/b-2.mp4', '第03集$https://media.example.org/a-3.mp4']
  const lines = parseLines('mp4', entries.join('#'))
  expect(lines.map(line => numbering(line).numeric)).toEqual([true, true])
  const primary = referenceLine(lines)!
  expect(numbering(primary).count).toBe(3)
  expect(numbering(primary).byNumber.get(1)?.url).toBe('https://media.example.org/a-1.mp4')
  expect(lines.flatMap(line => line.episodes).map(ep => ep.url)).toEqual([
    'https://media.example.org/a-1.mp4', 'https://media.example.org/a-2.mp4', 'https://media.example.org/a-3.mp4',
    'https://media.example.org/b-1.mp4', 'https://media.example.org/b-2.mp4',
  ])
})

it('keeps dated variety issues and mixed special episodes in their established positional order', () => {
  for (const titles of [['先导片上', '20241118', '20241125'], ['第01集', '特别篇01', '第02集']]) {
    const lines = parseLines('hls', titles.map((title, i) => `${title}$https://media.example.org/${i}.m3u8`).join('#'))
    expect(lines).toHaveLength(1)
    expect(lines[0].episodes.map(ep => ep.title)).toEqual(titles)
    expect(numbering(lines[0]).numeric).toBe(false)
  }
})
