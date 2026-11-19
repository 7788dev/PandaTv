import { describe, it, expect, vi } from 'vitest'
import { DoubanHttp, DataError } from '../src/main/data/http'
import { DoubanDataSource } from '../src/main/data/douban'
import { normalize, subtitleParts, landscapePhoto, principalCredits } from '../src/main/data/normalize'
import { invokeData, safeError, type Services } from '../src/main/ipc'
import { GENRES, LANES, REGIONS, matchesRegion, matchesYear, yearChoices, yearSpan } from '../src/main/data/taxonomy'
import { hotQueries, combineHotQueries } from '../src/main/data/hot-search'
import { MetadataStore } from '../src/main/data/store'
import { mkdtemp } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const card = (id = '26647087', overrides = {}) => ({ id, type: 'tv', title: '三体', card_subtitle: '2023 / 中国大陆 / 剧情 科幻 / 杨磊 / 张鲁一 于和伟', rating: { value: 8.8 }, pic: { large: 'https://img1.doubanio.com/view/photo/s_ratio_poster/public/subject.jpg' }, ...overrides })
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
const fetcher = (fn: (url: URL) => Response | Promise<Response>) => vi.fn((input: string | URL | Request) => fn(new URL(String(input)))) as unknown as typeof fetch

describe('real metadata contract normalization', () => {
  it('separates the two observed subtitle formats', () => {
    expect(subtitleParts('2023 / 中国大陆 / 剧情 科幻 / 杨磊')).toEqual({ year: 2023, region: '中国大陆', genres: ['剧情', '科幻'] })
    expect(subtitleParts('中国大陆 / 剧情 科幻 / 杨磊')).toEqual({ region: '中国大陆', genres: ['剧情', '科幻'] })
  })
  it('keeps the genres a detail response leaves out, so a work stays in its channel', () => {
    // 罗小黑战记 as Douban's detail endpoint returned it on 2026-11-16: three genres, five in the subtitle.
    const detail = normalize({ id: '10477598', type: 'tv', title: '罗小黑战记', year: '2011', episodes_count: 46, genres: ['剧情', '喜剧', '动作'], card_subtitle: '2011 / 中国大陆 / 剧情 喜剧 动作 动画 奇幻 / 木头 / 山新 皇贞季' })!
    expect(detail.item.genres).toEqual(['剧情', '喜剧', '动作', '动画', '奇幻'])
    expect(detail.item.type).toBe('anime')
    expect(normalize({ id: '1', type: 'movie', title: '纪录', genres: ['历史', '战争', '传记'], card_subtitle: '2020 / 英国 / 历史 战争 传记 纪录片 / 某导演' })!.item.type).toBe('doc')
    // Without a subtitle the listed genres stand; names of people are never read as genres.
    expect(normalize({ id: '2', type: 'tv', title: '无副标题', genres: ['剧情'] })!.item.genres).toEqual(['剧情'])
    expect(normalize({ id: '3', type: 'tv', title: '人名', genres: ['剧情'], card_subtitle: '2020 / 中国大陆 / 剧情 / 动画 / 喜剧' })!.item.genres).toEqual(['剧情'])
  })
  it('reads the poster of a collection row, which carries it as cover.url', () => {
    // movie_latest as Douban returned it on 2026-11-16: no pic, the poster is an object under cover.
    const row = { id: '37657706', type: 'movie', title: '余命一年买男人', card_subtitle: '2026 / 日本 / 剧情 爱情 / 某导演', rating: { value: 6.1 }, cover: { url: 'https://img3.doubanio.com/view/photo/m_ratio_poster/public/p2935853700.jpg', width: 1500, height: 2222, shape: 'rectangle' } }
    expect(normalize(row)!.item.poster).toBe('https://img3.doubanio.com/view/photo/m_ratio_poster/public/p2935853700.jpg')
    // The older string form and the usual pic object keep working; pic wins when both are present.
    expect(normalize({ ...row, cover: 'https://img1.doubanio.com/a.jpg' })!.item.poster).toBe('https://img1.doubanio.com/a.jpg')
    expect(normalize({ ...row, pic: { large: 'https://img2.doubanio.com/b.jpg' } })!.item.poster).toBe('https://img2.doubanio.com/b.jpg')
    // A cover hosted elsewhere is not an image this application loads.
    expect(normalize({ ...row, cover: { url: 'https://example.com/c.jpg' } })!.item.poster).toBeNull()
  })
  it('uses Douban identity and omits missing or false metadata', () => {
    const result = normalize(card('1', { year: '', rating: { value: 0 }, episodes_count: 30, durations: ['45分钟'], pic: {}, intro: '', original_title: '' }))!
    expect(result.item.id).toBe('db-1')
    expect(result.item.poster).toBeNull()
    expect(result.item).not.toHaveProperty('score')
    expect(result.item).not.toHaveProperty('episodes')
    expect(result.item).not.toHaveProperty('status')
    expect(result.item).not.toHaveProperty('originalTitle')
    expect(result.item.runtime).toBe(45)
    expect(result.totalEpisodes).toBe(30)
  })
  it('rejects non-film cards, hostile images and invalid identities', () => {
    expect(normalize({ card: 'chart', ...card() })).toBeNull()
    expect(normalize({ target_type: 'book', target: card() })).toBeNull()
    expect(normalize(card('../1'))).toBeNull()
    expect(normalize(card('1', { pic: { large: 'https://img1.doubanio.com.attacker.net/image.jpg' } }))?.item.poster).toBeNull()
    expect(normalize({ target_type: 'tv', target: card() })?.item.type).toBe('tv')
  })
  it('preserves real people and movie/series thematic distinctions', () => {
    const result = normalize(card('2', { genres: ['动画', '悬疑'], actors: [{ name: '真实姓名', character: '饰 角色' }], directors: [{ name: '导演姓名' }] }))!
    expect(result.item.type).toBe('anime')
    expect(result.item.cast).toEqual([{ name: '真实姓名', role: '饰 角色' }])
    expect(result.item.directors).toEqual(['导演姓名'])
    expect(landscapePhoto({ photos: [{ image: { large: { url: 'https://img1.doubanio.com/photo.jpg', width: 1280, height: 720 } } }] })).toContain('/photo.jpg')
  })
})

describe('channel filter vocabulary and queries', () => {
  it('offers a broad vocabulary for every channel without duplicates or tag separators', () => {
    for (const [type, values] of Object.entries(GENRES)) {
      expect(values.length, type).toBeGreaterThanOrEqual(50)
      expect(new Set(values).size, type).toBe(values.length)
      expect(values.every(value => !/[,，\s]/.test(value)), type).toBe(true)
    }
    expect(GENRES.anime).toEqual(expect.arrayContaining(['校园', '悬疑', '热血', '机甲', '运动']))
    expect(GENRES.tv).toEqual(expect.arrayContaining(['动作', '悬疑', '职场', '谍战', '古装']))
    for (const values of Object.values(REGIONS)) expect(values).toEqual(expect.arrayContaining(['中国大陆', '日本', '美国']))
  })
  it('offers only terms the live probe found titles for', () => {
    // docs/evidence/filter-vocabulary.json is written by `npm run probe:filters`; a term added
    // to the vocabulary without probing it, or one that came back sparse, fails here.
    const evidence = JSON.parse(readFileSync('docs/evidence/filter-vocabulary.json', 'utf8')) as { at: string; failing: number; rows: Array<{ type: string; dimension: string; term: string; count: number; error?: string }> }
    expect(evidence.failing).toBe(0)
    const probed = new Map(evidence.rows.map(row => [`${row.type} ${row.dimension} ${row.term}`, row]))
    const years = yearChoices(new Date(evidence.at).getFullYear())
    const offered = Object.keys(GENRES).flatMap(type => [
      ...GENRES[type as keyof typeof GENRES].map(term => `${type} genre ${term}`),
      ...REGIONS[type as keyof typeof REGIONS].map(term => `${type} region ${term}`),
      ...years.map(term => `${type} year ${term}`),
    ])
    expect(offered.length).toBeGreaterThan(600)
    expect([...probed.keys()].sort()).toEqual([...offered].sort())
    for (const key of offered) { const row = probed.get(key)!; expect(row.error, key).toBeUndefined(); expect(row.count, key).toBeGreaterThanOrEqual(6) }
  })
  it('uses the year and decade tags Douban actually indexes', () => {
    const years = yearChoices(2026)
    expect(years.slice(0, 3)).toEqual(['2026', '2025', '2024'])
    expect(years).toEqual(expect.arrayContaining(['2010', '2000年代', '90年代', '60年代', '更早']))
    // Four-digit decades below 2000 and arbitrary old years return nothing upstream.
    expect(years).not.toContain('1990年代')
    expect(years).not.toContain('1900')
    expect(yearSpan('90年代')).toEqual([1990, 1999])
    expect(yearSpan('更早')).toEqual([0, 1959])
    expect(yearSpan('1990年代')).toBeUndefined()
    expect(matchesYear(1994, '90年代')).toBe(true)
    expect(matchesYear(2000, '90年代')).toBe(false)
    expect(matchesYear(1957, '更早')).toBe(true)
    expect(matchesYear(2025, '2024')).toBe(false)
    expect(matchesYear(undefined, '2024')).toBe(false)
  })
  it('re-checks single countries on the title and trusts Douban for language groups', () => {
    expect(matchesRegion('中国大陆 / 中国香港', '中国香港')).toBe(true)
    expect(matchesRegion('意大利', '墨西哥')).toBe(false)
    expect(matchesRegion('澳大利亚', '欧美')).toBe(true)
    expect(matchesRegion(undefined, '美国')).toBe(false)
  })
  it('sends the channel scope and every selected filter as tags, with one request per page', async () => {
    const calls: URL[] = []
    const source = new DoubanDataSource({ imageUrl: value => value, fetch: fetcher(url => {
      calls.push(url)
      return json({ items: Array.from({ length: 30 }, (_, i) => card(String(100 + i), { card_subtitle: '2024 / 中国大陆 / 剧情 悬疑 / 导演' })), count: 30, total: 90 })
    }) })
    const page = await source.channel('tv', { sort: 'score', genre: '校园', region: '中国大陆', year: '2024' })
    expect(calls).toHaveLength(1)
    expect(calls[0].pathname).toMatch(/\/tv\/recommend$/)
    expect(calls[0].searchParams.get('tags')).toBe('电视剧,校园,中国大陆,2024')
    expect(calls[0].searchParams.get('sort')).toBe('S')
    // Genre membership is the upstream tag index: titles are not dropped for lacking it on the card.
    expect(page.items).toHaveLength(30)
    expect(page.next).not.toBeNull()
    await source.channel('tv', { sort: 'score', genre: '校园', region: '中国大陆', year: '2024' }, page.next!)
    expect(calls[1].searchParams.get('start')).toBe('30')
    await expect(source.channel('tv', { sort: 'hot' }, page.next!)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    for (const [type, lanes] of Object.entries(LANES)) expect(lanes.length, type).toBeGreaterThan(0)
  })
  it('drops other formats, years and countries, and keeps reading until a page is filled', async () => {
    const starts: string[] = []
    const source = new DoubanDataSource({ imageUrl: value => value, fetch: fetcher(url => {
      const start = url.searchParams.get('start')!
      starts.push(start)
      // The first upstream page holds only leaked titles; real matches start on the second.
      if (start === '0') return json({ items: [card('1', { card_subtitle: '2023 / 中国大陆 / 喜剧 动画 / 导演' }), card('2', { card_subtitle: '2022 / 中国大陆 / 剧情 / 导演' }), card('3', { card_subtitle: '2023 / 美国 / 剧情 / Director' }), ...Array.from({ length: 27 }, (_, i) => card(String(900 + i), { card_subtitle: '2021 / 中国大陆 / 剧情 / 导演' }))], count: 30, total: 32 })
      return json({ items: [card('4'), card('5')], count: 30, total: 32 })
    }) })
    const page = await source.channel('tv', { sort: 'hot', region: '中国大陆', year: '2023' })
    expect(page.items.map(item => item.id)).toEqual(['db-4', 'db-5'])
    expect(starts).toEqual(['0', '30'])
    expect(page.next).toBeNull()
  })
  it('bounds page filling and hands the cursor back when matches are sparse', async () => {
    let calls = 0
    const source = new DoubanDataSource({ imageUrl: value => value, fetch: fetcher(() => { calls++; return json({ items: Array.from({ length: 30 }, (_, i) => card(String(900 + i), { card_subtitle: '2023 / 中国大陆 / 真人秀 / 导演' })), count: 30, total: 500 }) }) })
    const page = await source.channel('tv', { sort: 'hot' })
    expect(page.items).toEqual([])
    expect(calls).toBe(4)
    expect(page.next).not.toBeNull()
  })
  it('re-reads a partial page instead of showing a few titles and ending the list', async () => {
    const full = Array.from({ length: 30 }, (_, i) => card(String(200 + i)))
    let calls = 0
    const source = new DoubanDataSource({ imageUrl: value => value, partialWaitMs: 0, fetch: fetcher(() => {
      // A filter Douban has not served recently: right total, one title that is not the first.
      return json(++calls === 1 ? { items: [full[2]], count: 30, total: 43 } : { items: full, count: 30, total: 43 })
    }) })
    const page = await source.channel('tv', { sort: 'hot', region: '中国大陆' })
    expect(calls).toBe(2)
    expect(page.items).toHaveLength(30)
    expect(page.items[0]!.id).toBe('db-200')
    expect(page.next).not.toBeNull()
    // The complete page is cached; the partial one never was.
    await source.channel('tv', { sort: 'hot', region: '中国大陆' })
    expect(calls).toBe(2)
  })
  it('reads a page that stays partial in smaller pages, which Douban does complete', async () => {
    const all = Array.from({ length: 43 }, (_, i) => card(String(200 + i)))
    const asked: string[] = []
    // Measured on tv/综艺/德国: 6 of 30 titles for over a minute, while 10-title pages were complete.
    const source = new DoubanDataSource({ imageUrl: value => value, partialWaitMs: 0, fetch: fetcher(url => {
      const start = Number(url.searchParams.get('start')), count = Number(url.searchParams.get('count'))
      asked.push(`${start}+${count}`)
      return json({ items: count === 30 ? [all[start + 7]] : all.slice(start, start + count), count, total: 43 })
    }) })
    const first = await source.channel('tv', { sort: 'hot', region: '中国大陆' })
    expect(asked).toEqual(['0+30', '0+30', '0+10', '10+10', '20+10'])
    expect(first.items.map(item => item.id)).toEqual(all.slice(0, 30).map(item => 'db-' + item.id))
    // The last range is shorter than a page: only the smaller pages that exist are read.
    const second = await source.channel('tv', { sort: 'hot', region: '中国大陆' }, first.next!)
    expect(asked.slice(5)).toEqual(['30+30', '30+30', '30+10', '40+10'])
    expect(second.items.map(item => item.id)).toEqual(all.slice(30).map(item => 'db-' + item.id))
    expect(second.next).toBeNull()
  })
  it('reports a listing that never completes as a timeout instead of a short or empty channel', async () => {
    let calls = 0
    const source = new DoubanDataSource({ imageUrl: value => value, partialWaitMs: 0, fetch: fetcher(() => { calls++; return json({ items: [card('300')], count: 30, total: 24 }) }) })
    await expect(source.channel('tv', { sort: 'hot', region: '中国大陆' })).rejects.toMatchObject({ code: 'TIMEOUT', retryable: true })
    // Two reads of the page, two of each 10-title page, then 5-title pages before giving up.
    expect(calls).toBeGreaterThan(8)
    expect(calls).toBeLessThanOrEqual(18)
    // Nothing was cached: the retry asks again and gets the page once Douban has it.
    await new Promise(resolve => setTimeout(resolve, 50))
    calls = 0
    await expect(source.channel('tv', { sort: 'hot', region: '中国大陆' })).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect(calls).toBeGreaterThan(8)
  })
  it('splits only the part of a page that stays partial', async () => {
    const all = Array.from({ length: 60 }, (_, i) => card(String(600 + i)))
    const asked: string[] = []
    const source = new DoubanDataSource({ imageUrl: value => value, partialWaitMs: 0, fetch: fetcher(url => {
      const start = Number(url.searchParams.get('start')), count = Number(url.searchParams.get('count'))
      asked.push(`${start}+${count}`)
      // The whole page and its middle third never complete; everything else does.
      const stuck = count === 30 || (start === 10 && count === 10)
      return json({ items: stuck ? [] : all.slice(start, start + count), count, total: 60 })
    }) })
    const page = await source.channel('tv', { sort: 'hot', region: '中国大陆' })
    expect(page.items.map(item => item.id)).toEqual(all.slice(0, 30).map(item => 'db-' + item.id))
    expect(asked.filter(value => value.endsWith('+5')).sort()).toEqual(['10+5', '15+5'])
  })
  it('keeps the lane that answered when the other one is still incomplete, and resumes it on the next page', async () => {
    const anime = (id: number, type: string) => card(String(id), { type, genres: ['动画'] })
    const full = Array.from({ length: 30 }, (_, i) => anime(400 + i, 'tv'))
    let cold = true
    const source = new DoubanDataSource({ imageUrl: value => value, partialWaitMs: 0, onWarning: () => {}, fetch: fetcher(url => {
      if (url.pathname.includes('/movie/')) return json(cold ? { items: [], count: 30, total: 40 } : { items: Array.from({ length: 30 }, (_, i) => anime(500 + i, 'movie')), count: 30, total: 40 })
      return json({ items: full, count: 30, total: 60 })
    }) })
    const first = await source.channel('anime', { sort: 'hot' })
    expect(first.items.length).toBeGreaterThan(0)
    expect(first.items.every(item => Number(item.id.slice(3)) < 500)).toBe(true)
    cold = false
    const second = await source.channel('anime', { sort: 'hot' }, first.next!)
    expect(second.items.some(item => item.id === 'db-500')).toBe(true)
  })
  it('rejects filters that are not a single tag or a known year choice', async () => {
    const source = new DoubanDataSource({ imageUrl: value => value, fetch: fetcher(() => json({ items: [], count: 30, total: 0 })) })
    await expect(source.channel('tv', { sort: 'hot', genre: '悬疑,综艺' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(source.channel('tv', { sort: 'hot', year: '1990年代' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(source.channel('tv', { sort: 'hot', year: '1890' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect((await source.channel('tv', { sort: 'hot', year: '更早' })).items).toEqual([])
  })
  it('lists filters without a network round trip', async () => {
    const source = new DoubanDataSource({ imageUrl: value => value, fetch: fetcher(() => { throw new Error('offline') }) })
    const filters = await source.filters('anime')
    expect(filters.genres).toContain('热血')
    expect(filters.years[0]).toBe(String(new Date().getFullYear()))
  })
  it('rejects malformed cursors, invalid responses and does not substitute mock lists', async () => {
    const source = new DoubanDataSource({ imageUrl: value => value, fetch: fetcher(() => json({ error: 'forbidden' })) })
    await expect(source.channel('movie', { sort: 'hot' })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    await expect(source.channel('movie', { sort: 'hot' }, Buffer.from('{}').toString('base64url'))).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(source.detail('../../x')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })
  it('deduplicates identities, filters non-film search cards and supports failed detail fallback', async () => {
    const source = new DoubanDataSource({ imageUrl: value => value, fetch: fetcher(url => {
      if (url.pathname.includes('/search/')) return json({ total: 2, items: [{ target_type: 'book', target: card() }, { target_type: 'tv', target: card() }] })
      if (url.pathname.endsWith('/credits')) return json({ items: [], total: 0 })
      if (url.pathname.endsWith('/photos')) return json({ photos: [] })
      if (url.pathname.includes('/movie/')) return json({}, 404)
      return json(card())
    }) })
    const found = await source.search('三体')
    expect(found).toHaveLength(1)
    expect((await source.detail('db-26647087')).title).toBe('三体')
    expect((await source.byIds(['db-26647087']))[0].title).toBe('三体')
  })
})

// 肖申克的救赎 (movie 1292052) as `credits` answered on 2026-11-17, trimmed to the fields read:
// 68 people are credited, the answer holds these eight rows.
const credit = (id: string, name: string, category: string, simple: string, photo: string) => ({ id, name, category, simple_character: simple, type: 'celebrity', avatar: { large: photo, normal: photo } })
const SHAWSHANK = { total: 68, items: [
  credit('1047973', '弗兰克·德拉邦特', '导演', '导演', 'https://img3.doubanio.com/view/celebrity/m/public/p230.jpg'),
  credit('1054521', '蒂姆·罗宾斯', '演员', '饰 安迪·杜佛兰 Andy Dufresne', 'https://img9.doubanio.com/view/celebrity/m/public/p17525.jpg'),
  credit('1054534', '摩根·弗里曼', '演员', "饰 艾利斯·波伊德·“瑞德”·瑞丁 Ellis Boyd 'Red' Redding", 'https://img3.doubanio.com/view/celebrity/m/public/p34642.jpg'),
  credit('1041179', '鲍勃·冈顿', '演员', '饰 监狱长山姆·诺顿 Warden Norton', 'https://img3.doubanio.com/view/celebrity/m/public/p5837.jpg'),
  credit('1000095', '威廉·赛德勒', '演员', '饰 海伍德 Heywood', 'https://img3.doubanio.com/view/celebrity/m/public/p7827.jpg'),
  credit('1013817', '克兰西·布朗', '演员', '饰 上尉哈德利 Captain Hadley', 'https://img3.doubanio.com/view/personage/m/public/af679543a3cc6a54afe91023a73b7348.jpg'),
  credit('1010612', '吉尔·贝罗斯', '演员', '饰 汤米 Tommy', 'https://img9.doubanio.com/view/celebrity/m/public/p1465659160.14.jpg'),
  credit('1047973', '弗兰克·德拉邦特', '编剧', '编剧', 'https://img3.doubanio.com/view/celebrity/m/public/p230.jpg'),
] }
// What Douban answers for someone without a photo, in a title's credits and in their own profile.
const SILHOUETTE = 'https://img3.doubanio.com/f/vendors/8dd0c794499fe925ae2ae89ee30cd225750457b4/pics/personage-default-medium.png'
const PROFILE_SILHOUETTE = { large: { url: 'https://asset.doubanio.com/cuphead/vendors/pics/personage-default-large.d29107214012.png' }, normal: { url: 'https://asset.doubanio.com/cuphead/vendors/pics/personage-default-medium.016343b9cfc5.png' } }
const billing = Array.from({ length: 25 }, (_, i) => ({ name: `演员${i + 1}` }))
const work = (id: number, overrides = {}) => ({ roles: ['演员 (饰 薛六)'], work: card(String(id), overrides) })

describe('the people of a title and their works', () => {
  it('lists each principal person once, with every job they hold', () => {
    const { people, cast } = principalCredits(SHAWSHANK)
    expect(people.map(person => person.name)).toEqual(['弗兰克·德拉邦特', '蒂姆·罗宾斯', '摩根·弗里曼', '鲍勃·冈顿', '威廉·赛德勒', '克兰西·布朗', '吉尔·贝罗斯'])
    expect(people[0]).toEqual({ id: '1047973', name: '弗兰克·德拉邦特', role: '导演 / 编剧', photo: 'https://img3.doubanio.com/view/celebrity/m/public/p230.jpg' })
    expect(people[1]).toEqual({ id: '1054521', name: '蒂姆·罗宾斯', role: '饰 安迪·杜佛兰 Andy Dufresne', photo: 'https://img9.doubanio.com/view/celebrity/m/public/p17525.jpg' })
    // The actors among them, in billing order: the director who also wrote the film is not one.
    expect(cast).toHaveLength(6)
    expect(cast[0]).toEqual({ name: '蒂姆·罗宾斯', role: '饰 安迪·杜佛兰 Andy Dufresne' })
  })
  it('shows no photo for a stock silhouette, a foreign host or a missing one, and no link without an identity', () => {
    const { people } = principalCredits({ items: [
      credit('1634774', '张春亚', '导演', '执行总导演', SILHOUETTE),
      credit('1', '外站头像', '演员', '嘉宾', 'https://example.com/view/celebrity/m/public/p1.jpg'),
      { name: '没有编号', category: '演员', simple_character: '主持人' },
      { id: '2', category: '演员' },
      // A row without Douban's short text falls back on the department it is listed under.
      { id: 3, name: '只有分类', category: '摄影' },
    ] })
    expect(people).toEqual([
      { id: '1634774', name: '张春亚', role: '执行总导演' },
      { id: '1', name: '外站头像', role: '嘉宾' },
      { name: '没有编号', role: '主持人' },
      { id: '3', name: '只有分类', role: '摄影' },
    ])
  })
  it('never lists more than the eight rows of the principal list, and rejects an answer that is not one', () => {
    const many = { items: Array.from({ length: 40 }, (_, i) => credit(String(100 + i), `演员${i}`, '演员', '演员', SILHOUETTE)) }
    expect(principalCredits(many).people).toHaveLength(8)
    expect(() => principalCredits({ actors: [], directors: [] })).toThrow(DataError)
  })
  it('shows the principal people of a title instead of everyone credited', async () => {
    const asked: string[] = []
    const source = new DoubanDataSource({ imageUrl: value => `proxy:${value}`, onWarning: () => {}, fetch: fetcher(url => {
      asked.push(url.pathname.replace('/rexxar/api/v2/', ''))
      if (url.pathname.endsWith('/credits')) return json(SHAWSHANK)
      if (url.pathname.endsWith('/photos')) return json({ photos: [] })
      return json(card('1292052', { type: 'movie', title: '肖申克的救赎', directors: [{ name: '弗兰克·德拉邦特' }], actors: billing }))
    }) })
    const detail = await source.detail('db-1292052')
    expect(asked).toEqual(['movie/1292052', 'movie/1292052/credits', 'movie/1292052/photos'])
    expect(detail.people).toHaveLength(7)
    expect(detail.people![0]).toEqual({ id: '1047973', name: '弗兰克·德拉邦特', role: '导演 / 编剧', photo: 'proxy:https://img3.doubanio.com/view/celebrity/m/public/p230.jpg' })
    // Of the 25 actors the title bills, the six leading ones are named; the director stays the title's own.
    expect(detail.cast!.map(person => person.name)).toEqual(['蒂姆·罗宾斯', '摩根·弗里曼', '鲍勃·冈顿', '威廉·赛德勒', '克兰西·布朗', '吉尔·贝罗斯'])
    expect(detail.directors).toEqual(['弗兰克·德拉邦特'])
    // The people are read from the answer each time and are not written into the title's record.
    expect((await source.byIds(['db-1292052']))[0]).not.toHaveProperty('people')
    expect((await source.detail('db-1292052')).people).toHaveLength(7)
  })
  it('names the head of the billing, without photos or links, when the principal list cannot be read', async () => {
    const warnings: string[] = []
    const source = new DoubanDataSource({ imageUrl: value => value, onWarning: warning => warnings.push(warning.operation), fetch: fetcher(url => {
      if (url.pathname.endsWith('/credits')) return json({}, 404)
      if (url.pathname.endsWith('/photos')) return json({ photos: [] })
      return json(card('1292052', { type: 'movie', actors: billing }))
    }) })
    const detail = await source.detail('db-1292052')
    expect(detail).not.toHaveProperty('people')
    expect(detail.cast).toEqual(billing.slice(0, 6))
    expect(warnings).toContain('credits:1292052')
  })
  it('reads a person by their Douban identity, with a photo only when they have one', async () => {
    const source = new DoubanDataSource({ imageUrl: value => `proxy:${value}`, fetch: fetcher(url => {
      if (url.pathname.endsWith('/celebrity/1274242')) return json({ id: '27481212', title: '黄渤', latin_title: 'Bo Huang', cover: { large: { url: 'https://img9.doubanio.com/view/celebrity/l/public/p1656.jpg' }, normal: { url: 'https://img9.doubanio.com/view/celebrity/m/public/p1656.jpg' } } })
      if (url.pathname.endsWith('/celebrity/1634774')) return json({ id: '38457026', title: '张春亚', cover: PROFILE_SILHOUETTE })
      if (url.pathname.endsWith('/celebrity/7')) return json({ id: '7', cover: {} })
      return json({ msg: 'traversal_error', code: 404 }, 404)
    }) })
    // The identity is the one the title's credits gave, not the other one the profile carries.
    expect(await source.person('1274242')).toEqual({ id: '1274242', name: '黄渤', photo: 'proxy:https://img9.doubanio.com/view/celebrity/m/public/p1656.jpg' })
    expect(await source.person('1634774')).toEqual({ id: '1634774', name: '张春亚' })
    await expect(source.person('7')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    await expect(source.person('9999999999')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(source.person('db-1274242')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })
  it('lists all works of a person a page at a time, in the order Douban gives them', async () => {
    const all = Array.from({ length: 70 }, (_, i) => work(700 + i))
    const asked: string[] = []
    const source = new DoubanDataSource({ imageUrl: value => value, partialWaitMs: 0, fetch: fetcher(url => {
      const start = Number(url.searchParams.get('start')), count = Number(url.searchParams.get('count'))
      asked.push(`${url.pathname.replace('/rexxar/api/v2/', '')} ${start}+${count}`)
      return json({ start, count, total: 70, works: all.slice(start, start + count) })
    }) })
    const first = await source.personWorks('1274242')
    expect(first.items.map(item => item.id)).toEqual(all.slice(0, 30).map(entry => 'db-' + entry.work.id))
    expect(first.next).toBe('30')
    const second = await source.personWorks('1274242', first.next!)
    const last = await source.personWorks('1274242', second.next!)
    expect(last.items).toHaveLength(10)
    expect(last.next).toBeNull()
    expect(asked).toEqual(['celebrity/1274242/works 0+30', 'celebrity/1274242/works 30+30', 'celebrity/1274242/works 60+30'])
    // A work listed here can be opened: its record says which kind of title it is.
    expect(source.getMetadata('db-700')).toMatchObject({ kind: 'tv' })
    for (const cursor of ['31', '-30', '30x', '3000000', '']) await expect(source.personWorks('1274242', cursor)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(source.personWorks('../1274242')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })
  it('re-reads a short page of works, splits one that stays short and leaves out what is not a film or series', async () => {
    const all = Array.from({ length: 43 }, (_, i) => i === 4 ? { roles: ['作者'], work: { id: '9', type: 'book', title: '一本书' } } : work(800 + i))
    const asked: string[] = []
    // As measured on 黄渤's works: a cold range answers with part of itself (37 of 50, 14 of 34).
    const source = new DoubanDataSource({ imageUrl: value => value, partialWaitMs: 0, fetch: fetcher(url => {
      const start = Number(url.searchParams.get('start')), count = Number(url.searchParams.get('count'))
      asked.push(`${start}+${count}`)
      const short = start === 0 ? asked.filter(value => value === '0+30').length === 1 : count === 30
      return json({ start, count, total: 43, works: short ? all.slice(start + 3, start + 9) : all.slice(start, start + count) })
    }) })
    const first = await source.personWorks('1274242')
    expect(asked).toEqual(['0+30', '0+30'])
    expect(first.items.map(item => item.id)).toEqual(all.slice(0, 30).filter(entry => entry.work.type !== 'book').map(entry => 'db-' + entry.work.id))
    const second = await source.personWorks('1274242', first.next!)
    expect(asked.slice(2)).toEqual(['30+30', '30+30', '30+10', '40+10'])
    expect(second.items.map(item => item.id)).toEqual(all.slice(30).map(entry => 'db-' + entry.work.id))
    expect(second.next).toBeNull()
  })
  it('says that a person, not a title, was not found, and takes nothing but a Douban identity from the window', async () => {
    const data = new DoubanDataSource({ imageUrl: value => value, fetch: fetcher(() => json({ msg: 'traversal_error', code: 404 }, 404)) })
    const services = { data, playback: {}, user: () => { throw new Error('unused') }, changed: () => {} } as unknown as Services
    for (const method of ['data.person', 'data.personWorks']) {
      const failure = await invokeData(method, ['9999999999'], services).catch(error => safeError(error))
      expect(failure).toEqual({ code: 'UNAVAILABLE', message: '未找到这位影人' })
      for (const bad of ['db-1', '1/works', '', 12, undefined]) await expect(invokeData(method, [bad], services)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    }
    await expect(invokeData('data.personWorks', ['1274242', 30], services)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(invokeData('data.personWorks', ['1274242', '999999999'], services)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })
})

describe('bounded metadata networking', () => {
  it('deduplicates in-flight work, returns defensive copies and expires cached responses', async () => {
    let count = 0
    const http = new DoubanHttp({ fetch: fetcher(async () => { count++; await new Promise(resolve => setTimeout(resolve, 10)); return json({ items: [1] }) }), intervalMs: 0 })
    const validate = (v: unknown) => v as { items: number[] }
    const url = 'https://m.douban.com/rexxar/api/v2/movie/recommend'
    const [first, second] = await Promise.all([http.json(url, 25, validate), http.json(url, 25, validate)])
    first.items.push(2)
    expect(second.items).toEqual([1])
    expect(count).toBe(1)
    await new Promise(resolve => setTimeout(resolve, 35))
    await http.json(url, 25, validate)
    expect(count).toBe(2)
  })
  it('retries transient status once but not 404 or invalid response', async () => {
    let count = 0
    const http = new DoubanHttp({ fetch: fetcher(() => json({}, ++count === 1 ? 503 : 200)), intervalMs: 0 })
    await http.json('https://m.douban.com/retry', 0, v => v)
    expect(count).toBe(2)
    count = 0
    const bad = new DoubanHttp({ fetch: fetcher(() => { count++; return json({}, 404) }), intervalMs: 0 })
    await expect(bad.json('https://m.douban.com/missing', 0, v => v)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(count).toBe(1)
  })
  it('lets a page of requests start together after a quiet spell, then paces the rest', async () => {
    const run = async (burst?: number) => {
      const starts: number[] = []
      const t0 = Date.now()
      const http = new DoubanHttp({ intervalMs: 60, maxConcurrent: 8, ...(burst ? { burst } : {}), fetch: fetcher(() => { starts.push(Date.now() - t0); return json({}) }) })
      await Promise.all(Array.from({ length: 7 }, (_, i) => http.json('https://m.douban.com/b' + i, 0, v => v)))
      return starts
    }
    // Four at once, then one per interval: the seventh leaves after three intervals, not six.
    const starts = await run()
    expect(starts[3]).toBeLessThan(45)
    expect(starts[4]).toBeGreaterThanOrEqual(55)
    expect(starts[6]).toBeGreaterThanOrEqual(175)
    expect(starts[6]).toBeLessThan(300)
    // Without a burst every start waits for its own interval.
    const paced = await run(1)
    expect(paced[1]).toBeGreaterThanOrEqual(55)
    expect(paced[6]).toBeGreaterThanOrEqual(355)
  })
  it('validates before caching, blocks hostile origins and enforces the concurrency ceiling', async () => {
    let active = 0, maximum = 0, calls = 0
    const http = new DoubanHttp({ intervalMs: 0, maxConcurrent: 2, fetch: fetcher(async () => { calls++; active++; maximum = Math.max(maximum, active); await new Promise(resolve => setTimeout(resolve, 5)); active--; return json({}) }) })
    await expect(http.json('http://127.0.0.1/private', 0, v => v)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    const invalid = () => { throw new DataError('INVALID_RESPONSE', 'invalid') }
    for (let i = 0; i < 2; i++) await expect(http.json('https://m.douban.com/invalid', 10000, invalid)).rejects.toThrow()
    expect(calls).toBe(2)
    await Promise.all(Array.from({ length: 8 }, (_, i) => http.json('https://m.douban.com/q' + i, 0, v => v)))
    expect(maximum).toBe(2)
  })
  it('turns an aborted request into a bounded timeout', async () => {
    const fetch = vi.fn((_input, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)))) as unknown as typeof globalThis.fetch
    const http = new DoubanHttp({ fetch, timeoutMs: 25, intervalMs: 0, retries: 0 })
    await expect(http.json('https://m.douban.com/slow', 0, v => v)).rejects.toMatchObject({ code: 'TIMEOUT' })
  })
})

describe('real heat ranking and durable metadata', () => {
  it('accepts only validated film search charts and merges by real heat values', () => {
    const raw = { success: true, data: { cards: [{ component: 'tabImgInfoList', content: [{ content: [{ title: '电影甲', Sa: 'fyb_movie', hotScore: { desc: '热搜指数', value: '500' } }, { title: '生活话题', Sa: 'fyb_realtime', hotScore: { desc: '热搜指数', value: '1000' } }] }] }] } }
    expect(hotQueries(raw, 'movie')).toEqual([{ title: '电影甲', score: 500 }])
    expect(() => hotQueries(raw, 'teleplay')).toThrow()
    expect(combineHotQueries([[{ title: '电影甲', score: 500 }], [{ title: '剧集乙', score: 600 }, { title: '电影甲', score: 200 }]])).toEqual(['剧集乙', '电影甲'])
  })
  it('restores real metadata without persisting dead proxy handles or erasing detail with cards', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'panda-metadata-'))
    const store = new MetadataStore(directory)
    await store.ready
    store.set([normalize(card('1', { intro: '真实接口简介', actors: [{ name: '张鲁一' }], episodes_count: 30 }))!])
    store.set([normalize(card('1', { pic: {} }))!])
    await store.flush()
    const restored = new MetadataStore(directory)
    await restored.ready
    expect(restored.get('db-1')?.item.synopsis).toBe('真实接口简介')
    expect(restored.get('db-1')?.item.poster).toMatch(/^https:/)
    expect(restored.get('db-1')?.item).not.toHaveProperty('episodes')
  })
})
