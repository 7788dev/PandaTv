import { describe, expect, it } from 'vitest'
import { episodeRange, matchRecord, matchesItem, numbering, parseLines, rank, runOf, workTerms } from '../src/main/playback/service'
import { normalize } from '../src/main/data/normalize'
import type { MediaItem, MediaType } from '../design/contract/types'

const item = (title: string, year: number, type: MediaType): MediaItem => ({ id: 'db-1', title, year, type, poster: null, backdrop: null, genres: [] })
const numbered = (count: number, from = 1) => parseLines('m3u8', Array.from({ length: count }, (_, i) => `第${String(from + i).padStart(2, '0')}集$https://example.com/${from + i}.m3u8`).join('#'))[0]!

// Subjects, aliases and catalogue records below were read from Douban and the play sources on 2026-11-16.
const run4 = item('凡人修仙传 年番4', 2026, 'anime')
const run4Aliases = ['凡人修仙传 第177-228集', '凡人修仙传 年番4之慕兰之战', '凡人修仙传：慕兰之战', '凡人修仙传 第五季', "A Record of a Mortal's Journey to Immortality"]
const serial = { vod_name: '凡人修仙传', vod_year: '2020', type_name: '国产动漫' }

describe('episode runs named by Douban aliases', () => {
  it.each([
    ['凡人修仙传 第177-228集', '凡人修仙传', 177, 228],
    ['斗破苍穹 年番 第158-219集', '斗破苍穹 年番', 158, 219],
    ['斗破苍穹年番 第1-52集', '斗破苍穹年番', 1, 52],
    ['吞噬星空131-156集', '吞噬星空', 131, 156],
    ['仙逆 第077-128集', '仙逆', 77, 128],
    ['斗罗大陆1 第183-234集', '斗罗大陆1', 183, 234],
    ['凡人修仙传 第153～176集', '凡人修仙传', 153, 176],
  ])('%s', (alias, name, first, last) => expect(episodeRange(alias)).toEqual({ name, first, last }))
  it('reads nothing else as a run', () => {
    for (const alias of ['凡人修仙传 第五季', '凡人修仙传：慕兰之战', '1917', '2001太空漫游', '24小时 第8季', '第1-12集', '凡人修仙传 第228-177集', '凡人修仙传 第0-12集', 'Mob Psycho 100']) expect(episodeRange(alias)).toBeUndefined()
  })
  it('captures the aliases from the subject record', () => {
    const subject = normalize({ id: '37457082', type: 'tv', title: '凡人修仙传 年番4', year: '2026', genres: ['动画'], episodes_count: 52, aka: run4Aliases })
    expect(subject).toMatchObject({ totalEpisodes: 52, aliases: run4Aliases })
    expect(normalize({ id: '1', type: 'movie', title: '无别名' })).not.toHaveProperty('aliases')
  })
})

describe('a subject that is a run of a longer serial', () => {
  const hints = { aliases: run4Aliases, totalEpisodes: 52 }
  it('is found in the record of the whole serial, at its place in it', () => {
    expect(matchRecord(run4, serial)).toBeUndefined()
    expect(matchRecord(run4, serial, hints)).toEqual({ range: { name: '凡人修仙传', first: 177, last: 228 } })
    // Catalogues that suffix the first-release year name the same serial.
    expect(matchRecord(run4, { ...serial, vod_name: '凡人修仙传2020' }, hints)?.range?.first).toBe(177)
  })
  it('rejects the same name when it is another kind of work, or newer than the run', () => {
    expect(matchRecord(run4, { vod_name: '凡人修仙传', vod_year: '2025', type_name: '国产剧' }, hints)).toBeUndefined()
    expect(matchRecord(run4, { vod_name: '凡人修仙传2025', vod_year: '2025', type_name: '国产剧' }, hints)).toBeUndefined()
    expect(matchRecord(run4, { vod_name: '凡人修仙传', vod_year: '', type_name: '脑洞悬疑' }, hints)).toBeUndefined()
    expect(matchRecord(run4, { ...serial, vod_year: '2027' }, hints)).toBeUndefined()
    expect(matchRecord(run4, { ...serial, vod_name: '凡人修仙传重制版' }, hints)).toBeUndefined()
    expect(matchRecord(run4, { ...serial, vod_name: '凡人修仙传解说', type_name: '动漫解说' }, hints)).toBeUndefined()
  })
  it('maps its episodes onto the serial numbering and offers only the ones released', () => {
    const range = matchRecord(run4, serial, hints)!.range!
    const run = runOf(numbered(200), range)!
    expect(numbering(run)).toMatchObject({ numeric: true, count: 24 })
    expect(numbering(run).byNumber.get(1)?.url).toBe('https://example.com/177.m3u8')
    expect(numbering(run).byNumber.get(24)?.url).toBe('https://example.com/200.m3u8')
    // Later runs of the serial are not this subject.
    expect(numbering(runOf(numbered(260), range)!).count).toBe(52)
    // The serial has not reached the run yet.
    expect(runOf(numbered(150), range)).toBeUndefined()
  })
  it('does not guess a place in a list that is not numbered', () => {
    const positional = parseLines('m3u8', Array.from({ length: 202 }, (_, i) => `${i % 2 ? '上' : '下'}${i}$https://example.com/${i}.m3u8`).join('#'))[0]!
    expect(numbering(positional).numeric).toBe(false)
    expect(runOf(positional, { name: '凡人修仙传', first: 177, last: 228 })).toBeUndefined()
    // Half the entries are something else: the numbers no longer describe the list.
    const mixed = parseLines('m3u8', Array.from({ length: 200 }, (_, i) => `${i % 2 ? '第' + i + '集' : '彩蛋' + i}$https://example.com/${i}.m3u8`).join('#'))[0]!
    expect(runOf(mixed, { name: '凡人修仙传', first: 1, last: 199 })).toBeUndefined()
  })
  it('reads the numbered episodes of a serial that also lists a few extras', () => {
    // As listed by three catalogues for one serial: a split episode, a finale special, a closing label.
    const entries = [...Array.from({ length: 239 }, (_, i) => `第${String(i + 1).padStart(2, '0')}集`), '第240集上', '第240集下', ...Array.from({ length: 22 }, (_, i) => `第${241 + i}集`), '第263集完结', '90分钟结局', '导演剪辑版']
    const line = parseLines('m3u8', entries.map((title, i) => `${title}$https://example.com/${i}.m3u8`).join('#'))[0]!
    expect(numbering(line).numeric).toBe(false)
    const run = runOf(line, { name: '斗罗大陆1', first: 235, last: 263 })!
    expect(numbering(run)).toMatchObject({ numeric: true, count: 29 })
    expect(numbering(run).byNumber.get(1)?.title).toBe('第235集')
    expect(numbering(run).byNumber.get(29)?.title).toBe('第263集完结')
    // The split episode has no single entry here; another line has to supply it.
    expect(numbering(run).byNumber.has(6)).toBe(false)
    expect(run.episodes).toHaveLength(28)
  })
  it('leaves out a number a line lists twice', () => {
    const entries = [...Array.from({ length: 60 }, (_, i) => `第${i + 1}话`), '第40话']
    const line = parseLines('m3u8', entries.map((title, i) => `${title}$https://example.com/${i}.m3u8`).join('#'))[0]!
    const run = runOf(line, { name: '斗罗大陆1', first: 31, last: 60 })!
    expect(run.episodes).toHaveLength(29)
    expect(numbering(run).byNumber.has(10)).toBe(false)
  })
  it('reads a closing label as the number of the last episode', () => {
    const line = parseLines('m3u8', ['第38集', '第39集', '第40集完结'].map((title, i) => `${title}$https://example.com/${i}.m3u8`).join('#'))[0]!
    expect(line.episodes.map(episode => episode.number)).toEqual([38, 39, 40])
    expect(parseLines('m3u8', '第240集上$https://example.com/a.m3u8')[0]!.episodes[0]!.number).toBeUndefined()
    // Captured 2026-11-17 (嫁金钗 on 红牛, 虎牙, 金鹰 and five more): a finished serial ends in "第30集已完结".
    // Unread, that one entry left the whole line without numbers and the source out of every episode.
    const finished = parseLines('hnm3u8', ['第01集', '第02集', '第03集已完结'].map((title, i) => `${title}$https://example.com/${i}.m3u8`).join('#'))[0]!
    expect(finished.episodes.map(episode => episode.number)).toEqual([1, 2, 3])
    expect(numbering(finished).numeric).toBe(true)
  })
  it('takes the longer of the alias and the episode count when they disagree', () => {
    const first = item('仙逆', 2023, 'anime')
    const record = { vod_name: '仙逆', vod_year: '2023', type_name: '国产动漫' }
    expect(matchRecord(first, record, { aliases: ['仙逆 第1-24集'], totalEpisodes: 76 })?.range).toMatchObject({ first: 1, last: 76 })
    expect(matchRecord(first, record, { aliases: ['仙逆 第1-76集'], totalEpisodes: 24 })?.range).toMatchObject({ first: 1, last: 76 })
    expect(matchRecord(first, record, { aliases: ['仙逆 第1-24集'] })?.range).toMatchObject({ first: 1, last: 24 })
  })
  it('requires the opening run to share the serial year', () => {
    const opening = item('凡人修仙传：风起天南', 2020, 'anime')
    const aliases = ['凡人修仙传 第一季', '凡人修仙传 第1-17集']
    expect(matchRecord(opening, serial, { aliases })?.range).toMatchObject({ first: 1, last: 17 })
    expect(matchRecord(opening, { ...serial, vod_year: '2019' }, { aliases })).toBeUndefined()
  })
  it('uses the range that names the record', () => {
    const run = item('斗破苍穹 年番4', 2026, 'anime')
    const aliases = ['斗破苍穹 年番 第158-219集', '斗破苍穹 第218-279集', '斗破苍穹 第八季']
    expect(matchRecord(run, { vod_name: '斗破苍穹年番', vod_year: '2022', type_name: '国产动漫' }, { aliases })?.range).toMatchObject({ first: 158, last: 219 })
    expect(matchRecord(run, { vod_name: '斗破苍穹', vod_year: '2017', type_name: '国产动漫' }, { aliases })?.range).toMatchObject({ first: 218, last: 279 })
    expect(matchRecord(item('斗罗大陆1 第五季', 2022, 'anime'), { vod_name: '斗罗大陆', vod_year: '2018', type_name: '国产动漫' }, { aliases: ['斗罗大陆1 第183-234集'] })?.range).toMatchObject({ first: 183 })
  })
})

describe('records filed under an alias', () => {
  const hints = { aliases: run4Aliases }
  it('accepts an alias only when the year and the category both confirm it', () => {
    const arc = { vod_name: '凡人修仙传 慕兰之战', vod_year: '2026', type_name: '国产动漫' }
    expect(matchRecord(run4, arc, hints)).toEqual({ weak: true })
    expect(matchRecord(run4, { ...arc, vod_year: '2025' }, hints)).toBeUndefined()
    expect(matchRecord(run4, { ...arc, vod_year: '2027' }, hints)).toBeUndefined()
    expect(matchRecord(run4, { ...arc, vod_year: '' }, hints)).toBeUndefined()
    expect(matchRecord(run4, { ...arc, type_name: '国产剧' }, hints)).toBeUndefined()
    expect(matchRecord(run4, { ...arc, type_name: '脑洞悬疑' }, hints)).toBeUndefined()
    expect(matchRecord(run4, { ...arc, vod_name: '凡人修仙传 外海风云' }, hints)).toBeUndefined()
    expect(matchRecord(run4, arc)).toBeUndefined()
  })
  it('reads regional titles without their note', () => {
    const film = item('肖申克的救赎', 1994, 'movie')
    const aliases = ['月黑高飞(港)', '刺激1995(台)', '地狱诺言']
    expect(matchRecord(film, { vod_name: '月黑高飞', vod_year: '1994', type_name: '剧情片' }, { aliases })).toEqual({ weak: true })
    expect(matchRecord(film, { vod_name: '刺激1995', vod_year: '1994', type_name: '剧情片' }, { aliases })).toEqual({ weak: true })
    expect(matchRecord(film, { vod_name: '月黑高飞', vod_year: '2011', type_name: '剧情片' }, { aliases })).toBeUndefined()
  })
  it('leaves title matches as they were', () => {
    const film = item('肖申克的救赎', 1994, 'movie')
    expect(matchRecord(film, { vod_name: '肖申克的救赎', vod_year: '1994', type_name: '剧情片' }, { aliases: ['月黑高飞(港)'] })).toEqual({})
    expect(matchesItem(film, { vod_name: '肖申克的救赎', vod_year: '1996', type_name: '剧情片' }, { aliases: ['月黑高飞(港)'] })).toBe(false)
  })
})

describe('a release year one off', () => {
  // 生命奇观: Douban 2023; two catalogues 2024, one under 大陆综艺 and one under 记录片 (2026-11-16).
  const work = item('生命奇观', 2023, 'doc')
  it('is weak evidence, and only with the same category', () => {
    expect(matchRecord(work, { vod_name: '生命奇观', vod_year: '2024', type_name: '记录片' })).toEqual({ weak: true })
    expect(matchRecord(work, { vod_name: '生命奇观', vod_year: '2022', type_name: '纪录片' })).toEqual({ weak: true })
    expect(matchRecord(work, { vod_name: '生命奇观', vod_year: '2023', type_name: '记录片' })).toEqual({})
    expect(matchRecord(work, { vod_name: '生命奇观', vod_year: '2024', type_name: '大陆综艺' })).toBeUndefined()
    expect(matchRecord(work, { vod_name: '生命奇观', vod_year: '2025', type_name: '记录片' })).toBeUndefined()
    expect(matchRecord(work, { vod_name: '生命奇观2', vod_year: '2024', type_name: '记录片' })).toBeUndefined()
    expect(matchRecord(item('夫妻一场', 2025, 'doc'), { vod_name: '夫妻一场', vod_year: '2024', type_name: '国产剧' })).toBeUndefined()
    expect(matchRecord(item('生日快乐', 2025, 'movie'), { vod_name: '生日快乐', vod_year: '2024', type_name: '脑洞悬疑' })).toBeUndefined()
  })
  it('gives way to a record of the exact year', () => {
    const near = { source: { priority: 9 }, lines: [numbered(3)], dubbed: false, weak: true }
    const exact = { source: { priority: 1 }, lines: [numbered(3)], dubbed: false, weak: false }
    expect(rank([near, exact])).toEqual([exact])
    expect(rank([near])).toEqual([near])
  })
})

describe('search terms for a work', () => {
  it('asks for the title first, then the serial, then Chinese aliases', () => {
    expect(workTerms('凡人修仙传 年番4', run4Aliases)).toEqual(['凡人修仙传', '凡人修仙传 年番', '凡人修仙传 年番4', '年番4之慕兰之战'])
    expect(workTerms('斗破苍穹 年番4', ['斗破苍穹 年番 第158-219集', '斗破苍穹 第218-279集'])).toEqual(['斗破苍穹', '斗破苍穹 年番', '斗破苍穹 年番4'])
    expect(workTerms('肖申克的救赎', ['月黑高飞(港)', '刺激1995(台)', '地狱诺言', 'The Shawshank Redemption'])).toEqual(['肖申克的救赎', '月黑高飞', '刺激1995'])
    expect(workTerms('1917')).toEqual(['1917'])
  })
})

describe('records of one work from several catalogues', () => {
  const record = (priority: number, lines: ReturnType<typeof numbered>[], extra: { run?: number; weak?: boolean; dubbed?: boolean } = {}) =>
    ({ source: { priority }, lines, dubbed: false, weak: false, ...extra })
  const counts = (records: Array<{ lines: ReturnType<typeof numbered>[] }>) => records.map(value => value.lines.map(line => numbering(line).count))
  it('cuts a record that also lists the following run to the extent Douban gives', () => {
    // 凡人修仙传：外海风云 is episodes 125-152 (28); one catalogue files 52 under that title.
    const run = record(5, [runOf(numbered(200), { name: '凡人修仙传', first: 125, last: 152 })!], { run: 28 })
    const longer = record(9, [numbered(52)])
    expect(counts(rank([longer, run]))).toEqual([[28], [28]])
  })
  it('drops a list without numbers when the run is known, and keeps it when it is all there is', () => {
    const annotated = parseLines('m3u8', ['第01集【总第125集】', '第02集【总第126集】'].map((title, i) => `${title}$https://example.com/a${i}.m3u8`).join('#'))[0]!
    const run = record(5, [numbered(28)], { run: 28 })
    expect(rank([record(9, [annotated]), run])).toEqual([run])
    expect(rank([record(9, [annotated])])).toHaveLength(1)
  })
  it('uses a record found under an alias only when there is no other', () => {
    const alias = record(9, [numbered(24)], { weak: true })
    const run = record(5, [numbered(24)], { run: 24 })
    expect(rank([alias, run])).toEqual([run])
    expect(rank([alias])).toEqual([alias])
  })
  it('orders by dub then source priority', () => {
    const records = [record(1, [numbered(3)]), record(9, [numbered(3)], { dubbed: true }), record(5, [numbered(3)])]
    expect(rank(records).map(value => value.source.priority)).toEqual([5, 1, 9])
  })
})
