// 自检：contract/ 和 mock/ 里的 TypeScript 规则，必须与预览（preview/js）的行为逐项一致。
// 设计稿有改动时跑一遍：node tools/test-contract.mjs（需要 Node 24，直接执行 .ts）
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const root = new URL('../', import.meta.url)
const json = (p) => JSON.parse(readFileSync(fileURLToPath(new URL(p, root)), 'utf8'))
const catalog = json('mock/catalog.json')
const copy = json('copy/zh-CN.json')

// 预览一侧
const core = await import('../preview/js/core.js')
core.data.catalog = catalog
core.data.copy = copy
for (const it of catalog.items) core.data.byId.set(it.id, it)
const parts = await import('../preview/js/parts.js')
const views = await import('../preview/js/views.js')

// 契约一侧
const rules = await import('../contract/rules.ts')
const consts = await import('../contract/constants.ts')
const { t, fmt } = await import('../contract/copy.ts')
const { createMockSource, createMockUser } = await import('../mock/source.ts')

let checks = 0
const same = (a, b, what) => {
  checks++
  assert.deepEqual(a, b, what)
}
const text = (html) => html.replace(/<[^>]+>/g, '').replace(/\s+/g, '')

// ── 文案 ──
same(t.action.play, copy.action.play, 'copy')
same(fmt('{a}-{b}', { a: 1, b: 50 }), core.fmt('{a}-{b}', { a: 1, b: 50 }), 'fmt')
same(fmt('x{n}', {}), 'x', 'fmt 缺变量')

// ── 常量 ──
same([...consts.SPEEDS], core.SPEEDS, 'SPEEDS')
same([...consts.QUALITIES], core.QUALITIES, 'QUALITIES')

// ── 片子 ──
for (const it of catalog.items) {
  same(rules.isSeries(it), core.isSeries(it), `isSeries ${it.id}`)
  same(rules.statusText(it) ?? '', core.statusText(it), `statusText ${it.id}`)
  same(rules.episodeLabel(it, 3), core.episodeLabel(it, 3), `episodeLabel ${it.id}`)
  for (const [region, max] of [[false, 2], [true, 3], [true, 2]]) {
    const mine = [rules.scoreText(it) ?? '', ...rules.metaParts(it, { region, genres: max })].join('').replace(/\s+/g, '')
    same(mine, text(parts.metaRow(it, { region, max })), `meta ${it.id}`)
  }
  // 卡片第二行：与预览的卡片模板输出一致
  const sub = parts.posterCard(it).match(/<div class="card__sub">([^<]*)<\/div>/)?.[1] ?? null
  same(rules.cardSub(it) ? core.esc(rules.cardSub(it)) : null, sub, `cardSub ${it.id}`)
}

// ── 进度与历史 ──
core.store.state = { favorites: [], history: [], searches: [], settings: {} }
for (const h of catalog.user.history) {
  const it = core.item(h.id)
  same(rules.isFinished(h), core.isFinished(h), `isFinished ${h.id}`)
  same(rules.progressText(it, h), core.progressText(it, h), `progressText ${h.id}`)
  const p = Number(parts.continueCard(h).match(/--p:(\d+)%/)[1])
  same(rules.progressPercent(h), p, `progressPercent ${h.id}`)
}
same(rules.isFinished({ position: 96, duration: 100 }), true, 'finished 96%')
same(rules.isFinished({ position: 95, duration: 100 }), false, 'finished 95%')
same(rules.isFinished({ position: 0, duration: 0 }), false, 'finished 0/0')
same(rules.historyRecord('a', 3, 2900.7, 3000, true), { id: 'a', episode: 4, position: 0, duration: 3000 }, '看完且有下一集')
same(rules.historyRecord('a', 3, 2900.7, 3000, false), { id: 'a', episode: 3, position: 2900, duration: 3000 }, '看完但没有下一集')
same(rules.historyRecord('a', 3, 120.9, 3000, true), { id: 'a', episode: 3, position: 120, duration: 3000 }, '没看完')
same(rules.addSearch(['a', 'b', 'c'], 'b'), ['b', 'a', 'c'], 'addSearch 去重')
same(rules.addSearch('abcdefgh'.split(''), 'x').length, 8, 'addSearch 上限')
same(rules.toggleFavorite(['a', 'b'], 'c'), ['c', 'a', 'b'], '收藏')
same(rules.toggleFavorite(['a', 'b'], 'a'), ['b'], '取消收藏')
same(rules.addHistory([{ id: 'a' }, { id: 'b' }], { id: 'b', x: 1 }), [{ id: 'b', x: 1 }, { id: 'a' }], 'addHistory')

const movie = catalog.items.find((x) => !x.episodes)
const series = catalog.items.find((x) => x.episodes)
same(rules.playLabel(movie, undefined), copy.action.play, 'playLabel 没看过')
same(rules.playLabel(movie, { episode: 1, position: 10, duration: 100 }), copy.action.resume, 'playLabel 单片没看完')
same(rules.playLabel(movie, { episode: 1, position: 99, duration: 100 }), copy.action.play, 'playLabel 单片看完')
same(rules.playLabel(series, { episode: 12, position: 99, duration: 100 }), '继续播放 第12集', 'playLabel 多集')
same(rules.resumePosition({ episode: 2, position: 50, duration: 100 }, 2), 50, 'resume 同一集')
same(rules.resumePosition({ episode: 2, position: 50, duration: 100 }, 3), 0, 'resume 另一集')
same(rules.resumePosition({ episode: 2, position: 99, duration: 100 }, 2), 0, 'resume 已看完')

const now = new Date(2026, 0, 15, 10).getTime()
const day = 86_400_000
const groups = rules.groupHistory([{ at: now - 1000 }, { at: now - day }, { at: now - 5 * day }, { at: now - 9 * day }], now)
same(groups.map((g) => [g.label, g.items.length]), [['今天', 1], ['昨天', 1], ['更早', 2]], 'groupHistory')
same(rules.groupHistory([{ at: now }], now).length, 1, 'groupHistory 空组不返回')

// ── 选集 ──
same(rules.episodeRanges(76).map((r) => r.label), ['1-50', '51-76'], 'ranges 76')
same(rules.episodeRanges(24).length, 1, 'ranges 24')
same(rules.rangeOf(rules.episodeRanges(120), 51)?.label, '51-100', 'rangeOf')
same(rules.rangeOf(rules.episodeRanges(120), undefined)?.label, '1-50', 'rangeOf 默认')
same([rules.episodeState(3, 5), rules.episodeState(5, 5), rules.episodeState(6, 5), rules.episodeState(6, undefined)], ['watched', 'current', 'default', 'default'], 'episodeState')
same(text(views.episodeCells(series, 5, { from: 4, to: 6 })).length > 0, true, 'episodeCells')

// ── 播放 ──
for (const s of [-5, 0, 59, 60, 3599, 3600, 7325.9, NaN, Infinity]) same(rules.clock(s), core.clock(s), `clock ${s}`)
for (const v of consts.SPEEDS) same(rules.speedLabel(v), core.speedLabel(v), `speedLabel ${v}`)
same(rules.speedButtonLabel(1), copy.player.speed, 'speedButtonLabel 1')
same(rules.speedButtonLabel(1.5), '1.5×', 'speedButtonLabel 1.5')
same([rules.volumeIcon(0.8, false), rules.volumeIcon(0.3, false), rules.volumeIcon(0, false), rules.volumeIcon(0.8, true)], ['volume', 'volume-low', 'volume-mute', 'volume-mute'], 'volumeIcon')
const intro = { intro: { start: 0, end: 90 } }
same(rules.startPosition(intro, { skipIntro: true }), 90, 'start 自动跳过')
same(rules.startPosition(intro, { skipIntro: false }), 0, 'start 不跳过')
same(rules.startPosition({}, { skipIntro: true }), 0, 'start 没有片头')
same([1, 2, 50, 87, 88].map((p) => rules.showSkipIntro(p, intro, { skipIntro: false })), [false, true, true, true, false], 'showSkipIntro')
same(rules.showSkipIntro(50, intro, { skipIntro: true }), false, 'showSkipIntro 已自动跳过')
same(rules.endPosition({ outro: 2700 }, 2880, { skipIntro: true }), 2700, 'end 跳过片尾')
same(rules.endPosition({ outro: 2700 }, 2880, { skipIntro: false }), 2880, 'end 不跳过')
same(rules.endPosition({}, 2880, { skipIntro: true }), 2880, 'end 没有片尾')
const on = { hasNext: true, autoNext: true, cancelled: false }
same([2869, 2870.5, 2879.2, 2880].map((p) => rules.upNextSeconds(p, 2880, on)), [null, 10, 1, null], 'upNext')
same(rules.upNextSeconds(2875, 2880, { ...on, cancelled: true }), null, 'upNext 已取消')
same(rules.upNextSeconds(2875, 2880, { ...on, hasNext: false }), null, 'upNext 没有下一集')

// ── 演示数据源 ──
const source = createMockSource(catalog, { asset: (p) => `/x/${p}` })
const home = await source.home()
same(home.hero.map((x) => x.id), catalog.home.hero, 'home.hero')
same(home.shelves.map((s) => s.kind), catalog.home.shelves.map((s) => s.kind), 'home.shelves')
same(Object.keys(home.shelves[0]), ['id', 'kind'], '继续观看只是占位')
same(home.hero[0].poster, `/x/${catalog.items.find((x) => x.id === catalog.home.hero[0]).poster}`, '图片地址经过 asset')
same((await source.detail(catalog.items.find((x) => !x.poster).id)).poster, null, '没有海报仍是 null')
for (const q of ['雾港', '悬疑', '周予安', '纪录片', 'the', '不存在', ' ']) {
  same((await source.search(q)).map((x) => x.id), views.searchItems(q).map((x) => x.id), `search ${q}`)
  same((await source.suggest(q)).length <= 8, true, `suggest ${q}`)
}
const tv = catalog.items.filter((x) => x.type === 'tv')
same((await source.channel('tv', { sort: 'hot' })).items.map((x) => x.id), tv.map((x) => x.id), 'channel 全部')
same((await source.channel('tv', { sort: 'hot', genre: '古装', region: '韩国' })).items.length, 0, 'channel 无结果')
same((await source.channel('tv', { sort: 'score' })).items[0].score, Math.max(...tv.map((x) => x.score)), 'channel 高分')
same((await source.channel('tv', { sort: 'hot', year: '更早' })).items.every((x) => x.year < 2023), true, 'channel 更早')
const paged = createMockSource(catalog, { asset: () => undefined, pageSize: 6 })
const p1 = await paged.channel('tv', { sort: 'hot' })
const p2 = await paged.channel('tv', { sort: 'hot' }, p1.next)
same([p1.items.length, p1.next, p2.items[0].id], [6, '6', tv[6].id], 'channel 分页')
same((await paged.detail(tv[0].id)).poster, null, 'asset 换不出来给 null')
same((await source.related(tv[0].id)).length <= 14, true, 'related 上限')
same((await source.byIds([tv[1].id, 'nope', tv[0].id])).map((x) => x.id), [tv[1].id, tv[0].id], 'byIds 顺序')
same((await source.hotSearches()).length, 10, 'hotSearches')
same((await source.playback(tv[0].id, 1)).intro, { start: 0, end: 90 }, 'playback 片头')
same((await source.playback(movie.id, 1, '720P')).quality, '720P', 'playback 清晰度')
await assert.rejects(() => source.detail('nope'), 'detail 找不到要抛错')
await assert.rejects(() => createMockSource(catalog, { asset: () => undefined, fail: (op) => op === 'home' }).home(), 'fail 选项')
const user = createMockUser(catalog, now)
same([user.favorites.length, user.history.length, user.history[0].at, 'daysAgo' in user.history[0]], [catalog.user.favorites.length, catalog.user.history.length, now, false], 'mockUser')

console.log(`contract ok · ${checks} checks`)
