import { describe, expect, it } from 'vitest'
import { classifySourceType, issueKey, matchesItem, numbering, parseLines, referenceLine, sameIssue, searchTerms, titleKey } from '../src/main/playback/service'
import type { MediaItem, MediaType } from '../design/contract/types'

const item = (title: string, year: number, type: MediaType): MediaItem => ({ id: 'db-1', title, year, type, poster: null, backdrop: null, genres: [] })
const line = (titles: string[]) => parseLines('m3u8', titles.map((title, i) => `${title}$https://example.com/${i}.m3u8`).join('#'))[0]!

// Record shapes below are taken from live maccms responses captured on 2026-11-16.
describe('source shelf classification', () => {
  it.each([
    ['剧情片', 'movie'], ['喜剧片', 'movie'], ['动作片', 'movie'], ['伦理片', 'movie'], ['电影', 'movie'],
    ['国产剧', 'tv'], ['香港剧', 'tv'], ['泰国剧', 'tv'], ['欧美剧', 'tv'], ['日剧', 'tv'], ['短剧', 'tv'], ['连续剧', 'tv'],
    ['大陆综艺', 'variety'], ['日韩综艺', 'variety'], ['国产动漫', 'anime'], ['动画片', 'anime'], ['动漫电影', 'anime'],
    ['纪录片', 'doc'], ['记录片', 'doc'],
  ])('%s is %s', (shelf, type) => expect(classifySourceType(shelf)).toBe(type))
  it('leaves unknown shelves unclassified', () => {
    for (const shelf of ['脑洞悬疑', '现代都市', '体育赛事', '']) expect(classifySourceType(shelf)).toBeUndefined()
  })
})

describe('title identity', () => {
  it('treats season spellings as one work and an unmarked title as the first season', () => {
    expect(titleKey('现在就出发 第二季')).toMatchObject({ base: '现在就出发', season: 2 })
    expect(titleKey('现在就出发第2季')).toMatchObject({ base: '现在就出发', season: 2 })
    expect(titleKey('一饭封神2')).toMatchObject({ base: '一饭封神', season: 2 })
    expect(titleKey('怪奇物语 第十二季').season).toBe(12)
    expect(titleKey('赛博朋克：边缘行者 第一季')).toMatchObject(titleKey('赛博朋克:边缘行者'))
  })
  it('does not read years or numeric names as seasons', () => {
    expect(titleKey('披荆斩棘2026')).toMatchObject({ base: '披荆斩棘2026', season: 1 })
    expect(titleKey('1917')).toMatchObject({ base: '1917', season: 1 })
    expect(titleKey('2001太空漫游').season).toBe(1)
  })
  it('marks dubbed records without changing their identity', () => {
    expect(titleKey('空枪粤语')).toEqual({ base: '空枪', season: 1, dubbed: true })
    expect(titleKey('肖申克的救赎（国语版）')).toEqual({ base: '肖申克的救赎', season: 1, dubbed: true })
    expect(titleKey('空枪').dubbed).toBe(false)
  })
})

describe('matching catalogue records', () => {
  it('accepts films filed under 剧情片/喜剧片', () => {
    expect(matchesItem(item('肖申克的救赎', 1994, 'movie'), { vod_name: '肖申克的救赎', vod_year: '1994', type_name: '剧情片' })).toBe(true)
    expect(matchesItem(item('祝你生日快乐', 2019, 'movie'), { vod_name: '祝你生日快乐', vod_year: '2019', type_name: '喜剧片' })).toBe(true)
  })
  it('accepts season spellings and year-suffixed names, and rejects other seasons', () => {
    const show = item('现在就出发 第二季', 2024, 'variety')
    expect(matchesItem(show, { vod_name: '现在就出发第二季', vod_year: '2024', type_name: '大陆综艺' })).toBe(true)
    expect(matchesItem(show, { vod_name: '现在就出发第三季', vod_year: '2025', type_name: '大陆综艺' })).toBe(false)
    expect(matchesItem(show, { vod_name: '现在就出发', vod_year: '2023', type_name: '大陆综艺' })).toBe(false)
    expect(matchesItem(item('赛博朋克：边缘行者 第一季', 2022, 'anime'), { vod_name: '赛博朋克：边缘行者', vod_year: '2022', type_name: '日韩动漫' })).toBe(true)
    expect(matchesItem(item('生日快乐', 2007, 'movie'), { vod_name: '生日快乐2007', vod_year: '2007', type_name: '爱情片' })).toBe(true)
    expect(matchesItem(item('凡人修仙传', 2020, 'anime'), { vod_name: '凡人修仙传2020', vod_year: '2020', type_name: '国产动漫' })).toBe(true)
  })
  it('rejects remakes, other formats and commentary uploads', () => {
    expect(matchesItem(item('生日快乐', 2025, 'movie'), { vod_name: '生日快乐', vod_year: '2007', type_name: '爱情片' })).toBe(false)
    expect(matchesItem(item('生日快乐', 2018, 'movie'), { vod_name: '生日快乐', vod_year: '2018', type_name: '海外剧' })).toBe(false)
    expect(matchesItem(item('凡人修仙传', 2020, 'anime'), { vod_name: '凡人修仙传重制版', vod_year: '2020', type_name: '国产动漫' })).toBe(false)
    expect(matchesItem(item('肖申克的救赎', 1994, 'movie'), { vod_name: '肖申克的救赎[电影解说]', vod_year: '1994', type_name: '电影解说' })).toBe(false)
    expect(matchesItem(item('珠穆朗玛：云中彼岸', 2026, 'doc'), { vod_name: '珠穆朗玛：云中彼岸（预告片）', vod_year: '2026', type_name: '预告片' })).toBe(false)
    expect(matchesItem(item('凡人修仙传', 2023, 'tv'), { vod_name: '凡人修仙传', vod_year: '', type_name: '脑洞悬疑' })).toBe(false)
  })
  it('accepts misfiled non-fiction only with a confirmed title and year', () => {
    const doc = item('生命奇观', 2024, 'doc')
    expect(matchesItem(doc, { vod_name: '生命奇观', vod_year: '2024', type_name: '大陆综艺' })).toBe(true)
    expect(matchesItem(doc, { vod_name: '生命奇观', vod_year: '2024', type_name: '记录片' })).toBe(true)
    expect(matchesItem(doc, { vod_name: '生命奇观', vod_year: '', type_name: '大陆综艺' })).toBe(false)
    expect(matchesItem(item('夫妻一场', 2025, 'doc'), { vod_name: '夫妻一场', vod_year: '2024', type_name: '国产剧' })).toBe(false)
    expect(matchesItem(item('凡人修仙传', 2025, 'tv'), { vod_name: '凡人修仙传', vod_year: '2025', type_name: '国产动漫' })).toBe(false)
  })
})

describe('search terms', () => {
  it('searches the distinctive part first so spacing and season spelling cannot hide a record', () => {
    expect(searchTerms('现在就出发 第二季')).toEqual(['现在就出发', '现在就出发 第二季'])
    expect(searchTerms('一饭封神2')).toEqual(['一饭封神', '一饭封神2'])
    expect(searchTerms('赛博朋克：边缘行者 第一季')[0]).toBe('赛博朋克')
    expect(searchTerms('赛博朋克：边缘行者 第一季')).toContain('赛博朋克：边缘行者')
    expect(searchTerms('肖申克的救赎')).toEqual(['肖申克的救赎'])
    expect(searchTerms('Doctor X：白色黑手党时代')[0]).toBe('白色黑手党时代')
    expect(searchTerms('1917')).toEqual(['1917'])
  })
})

describe('episode numbering', () => {
  it('uses numbers when every entry is a plausible unique episode number', () => {
    const plan = numbering(line(['第01集', '第02集', '第04集']))
    expect(plan).toMatchObject({ numeric: true, count: 4 })
    expect(plan.byNumber.get(4)?.url).toBe('https://example.com/2.m3u8')
    expect(plan.byNumber.has(3)).toBe(false)
  })
  it('addresses dated issues, mixed and annotated lists by position', () => {
    const dated = numbering(line(['20241019', '20241024', '20241026']))
    expect(dated).toMatchObject({ numeric: false, count: 3 })
    expect(dated.byNumber.get(1)?.title).toBe('20241019')
    expect(numbering(line(['第01集', '第02集', '番外']))).toMatchObject({ numeric: false, count: 3 })
    expect(numbering(line(['第01集【总第125集】', '第02集【总第126集】']))).toMatchObject({ numeric: false, count: 2 })
    expect(numbering(line(['第01集', '第01集']))).toMatchObject({ numeric: false, count: 2 })
  })
  it('tells a list of named issues from one that is only an order', () => {
    expect(numbering(line(['20241019', '20241024'])).titled).toBe(true)
    expect(numbering(line(['第01集【总第125集】', '第02集【总第126集】'])).titled).toBe(true)
    expect(numbering(line(['HD中字'])).titled).toBe(true)
    expect(numbering(line(['第01集', '第02集'])).titled).toBe(false)
    expect(numbering(line(['第01集', '第02集', '第特别篇01集'])).titled).toBe(false)
    expect(numbering(line(['', ''])).titled).toBe(false)
  })
  it('does not let specials mixed into one list redefine the episodes', () => {
    // 斗破苍穹 第一季 as one source lists it on 2026-11-16: twelve episodes and two specials on one line.
    const twelve = ['第01集', '第02集', '第03集', '第04集', '第05集', '第06集', '第07集', '第08集', '第09集', '第10集', '第11集', '第12集']
    const numberedLine = line(twelve), mixed = line([...twelve, '第特别篇01集', '第特别篇02集'])
    expect(numbering(mixed)).toMatchObject({ numeric: false, titled: false, count: 14 })
    expect(referenceLine([mixed, numberedLine])).toBe(numberedLine)
    // Alone, it is still the only description of the work there is.
    expect(referenceLine([mixed])).toBe(mixed)
    // Named issues keep competing on completeness.
    const dated = line(['20241019', '20241024', '20241026'])
    expect(referenceLine([line(['第1期', '第2期']), dated])).toBe(dated)
    expect(referenceLine([])).toBeUndefined()
  })
})

// Issue lists of one variety season as six sources spelled them on 2026-11-17.
describe('the same issue of a show on another source', () => {
  const reference = line(['先导片上', '先导片下', '第20251023期', '第20251025期', '第20251026期', '第20260104期特别加更', '第20260110期特别加更'])
  const of = (title: string) => reference.episodes.find(entry => entry.title === title)!
  const found = (title: string, other: string[]) => sameIssue(of(title), reference, line(other))?.title

  it('reads the date and the name out of the decoration', () => {
    expect(issueKey('第20251025期上')).toEqual({ date: '20251025', rest: '上' })
    expect(issueKey('20251025(上)')).toEqual({ date: '20251025', rest: '上' })
    expect(issueKey('20260104特别加更')).toEqual(issueKey('第20260104期特别加更'))
    expect(issueKey('先导片上')).toEqual({ rest: '先导片上' })
    expect(issueKey('第1期上')).toEqual({ rest: '第1期上' })
  })
  it('finds an issue by date wherever the other source lists it', () => {
    expect(found('第20251025期', ['20251018', '20251019', '20251023', '20251025'])).toBe('20251025')
    expect(found('第20260104期特别加更', ['20260110(特别加更)', '20260104(特别加更)'])).toBe('20260104(特别加更)')
    // One issue that day on both sides, one name containing the other.
    expect(found('第20251025期', ['20251025上', '20251026下'])).toBe('20251025上')
  })
  it('finds a named issue on a source that dates its issues', () => {
    expect(found('先导片上', ['第20251018期先导片上', '第20251019期先导片下', '第20251025期上'])).toBe('第20251018期先导片上')
  })
  it('gives no match rather than a guess', () => {
    // Two issues that day on the other source, neither called the same.
    expect(found('第20251025期', ['20251025上', '20251025下'])).toBeUndefined()
    // The same day, but another part of it.
    expect(sameIssue(line(['第20251025期上']).episodes[0]!, line(['第20251025期上']), line(['20251025下']))).toBeUndefined()
    // A name the other source uses twice, and one it spells differently.
    expect(found('先导片上', ['先导片上', '先导片上'])).toBeUndefined()
    expect(found('先导片上', ['20251018先导片', '20251019先导片'])).toBeUndefined()
    // The same name under another date is another issue.
    expect(found('第20260104期特别加更', ['20260110特别加更'])).toBeUndefined()
    // An entry that is not of the reference line at all.
    expect(sameIssue(line(['20251025']).episodes[0]!, reference, line(['20251025']))).toBeUndefined()
  })
})
