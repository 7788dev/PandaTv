import { test, expect } from '@playwright/test'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ChannelQuery, MediaType } from '../design/contract/types'
import { launch, capture, evidenceDir } from './desktop'

test('real Douban metadata, detailed channel facets, suggestions, hot searches and pagination', async () => {
  test.setTimeout(300000)
  const { app, page, errors } = await launch()
  const evidence: Record<string, unknown> = { at: new Date().toISOString(), facets: [], queries: [] }
  try {
    await expect(page.locator('.hero__title')).toBeVisible()
    // A first start shows the top of the page and adds the shelves below as they arrive.
    await expect.poll(() => page.evaluate(async () => (await window.panda.data.home()).shelves.length), { timeout: 30000 }).toBe(7)
    await expect.poll(() => page.locator('main .section').count()).toBeGreaterThanOrEqual(6)
    evidence.home = await page.evaluate(async () => {
      const feed = await window.panda.data.home()
      return { hero: feed.hero.map(item => ({ id: item.id, title: item.title })), shelves: feed.shelves.map(shelf => ({ id: shelf.id, kind: shelf.kind })) }
    })
    // Every shelf and board shows artwork: a collection whose rows name the poster differently
    // once left a whole shelf as title cards. Decoded in the real window, through the media proxy.
    const artwork = await page.evaluate(async () => {
      const feed = await window.panda.data.home()
      const groups = [{ name: 'hero', items: feed.hero }, ...feed.shelves.flatMap(shelf => 'boards' in shelf ? shelf.boards.map(board => ({ name: board.title, items: board.items })) : 'items' in shelf ? [{ name: shelf.id, items: shelf.items }] : [])]
      return Promise.all(groups.map(async group => {
        const decoded = await Promise.all(group.items.filter(item => item.poster).map(item => new Promise<boolean>(resolve => {
          const image = new Image()
          image.onload = () => resolve(image.naturalWidth > 0); image.onerror = () => resolve(false)
          image.src = item.poster!
        })))
        return { name: group.name, items: group.items.length, withPoster: decoded.length, decoded: decoded.filter(Boolean).length }
      }))
    })
    evidence.artwork = artwork
    for (const group of artwork) {
      expect(group.items, `${group.name} has items`).toBeGreaterThan(0)
      expect(group.withPoster, `${group.name} items carry a poster`).toBeGreaterThanOrEqual(Math.ceil(group.items * 0.8))
      expect(group.decoded, `${group.name} posters decode`).toBe(group.withPoster)
    }
    const cases: { type: MediaType; genres: string[] }[] = [
      { type: 'tv', genres: ['动作', '悬疑', '校园'] },
      { type: 'movie', genres: ['动作', '悬疑', '校园'] },
      { type: 'anime', genres: ['校园', '悬疑', '热血'] },
      { type: 'variety', genres: ['音乐', '真人秀', '旅行'] },
      { type: 'doc', genres: ['自然', '历史', '科学'] },
    ]
    for (const entry of cases) {
      const filters = await page.evaluate(type => window.panda.data.filters(type), entry.type)
      expect(filters.genres.length).toBeGreaterThanOrEqual(50)
      expect(filters.regions.length).toBeGreaterThanOrEqual(8)
      expect(filters.years).toContain('2024')
      expect(filters.years).toContain('2000年代')
      ;(evidence.facets as unknown[]).push({ type: entry.type, ...filters })
      for (const genre of entry.genres) {
        const start = Date.now()
        const result = await page.evaluate(async ({ type, genre }) => {
          let cursor: string | undefined, attempts = 0
          const all: { id: string; title: string; year?: number; region?: string; genres: string[] }[] = []
          do {
            const result = await window.panda.data.channel(type, { sort: 'hot', genre }, cursor)
            all.push(...result.items.map(({ id, title, year, region, genres }) => ({ id, title, year, region, genres })))
            cursor = result.next ?? undefined
          } while (cursor && !all.length && ++attempts < 3)
          return { type, genre, items: all.slice(0, 5), count: all.length, hasMore: Boolean(cursor) }
        }, { type: entry.type, genre })
        ;(evidence.queries as unknown[]).push({ ...result, ms: Date.now() - start })
        console.log('Real filter:', entry.type, genre, result.count)
        expect(result.count, `${entry.type}/${genre} must contain verified real results`).toBeGreaterThan(0)
      }
    }
    const query: ChannelQuery = { sort: 'score', genre: '悬疑', region: '中国大陆', year: '2024' }
    const combined = await page.evaluate(query => window.panda.data.channel('tv', query), query)
    expect(combined.items.length).toBeGreaterThan(0)
    // Year and country are re-checked on every title; genre membership is Douban's tag index.
    expect(combined.items.every(item => item.type === 'tv' && item.year === 2024 && item.region?.includes('中国大陆'))).toBe(true)
    expect(combined.items.some(item => item.genres.includes('悬疑'))).toBe(true)
    for (const [year, from, to] of [['90年代', 1990, 1999], ['更早', 0, 1959]] as const) {
      const old = await page.evaluate(year => window.panda.data.channel('movie', { sort: 'score', year }), year)
      expect(old.items.length, year).toBeGreaterThan(0)
      expect(old.items.every(item => item.year! >= from && item.year! <= to), year).toBe(true)
      ;(evidence.queries as unknown[]).push({ type: 'movie', year, count: old.items.length, items: old.items.slice(0, 5).map(({ id, title, year }) => ({ id, title, year })) })
    }
    evidence.combined = combined.items.map(({ id, title, year, region, score }) => ({ id, title, year, region, score }))
    if (combined.next) {
      const next = await page.evaluate(({ query, cursor }) => window.panda.data.channel('tv', query, cursor), { query, cursor: combined.next })
      evidence.pagination = { firstCount: combined.items.length, nextCount: next.items.length, cursorAdvanced: next.next !== combined.next }
      expect(next.next).not.toBe(combined.next)
    }
    evidence.search = await page.evaluate(async () => (await window.panda.data.search('三体')).map(({ id, title, type, year }) => ({ id, title, type, year })))
    const suggestions = await page.evaluate(() => window.panda.data.suggest('三体'))
    expect(suggestions.length).toBeGreaterThan(0)
    expect(suggestions.length).toBeLessThanOrEqual(8)
    const hot = await page.evaluate(() => window.panda.data.hotSearches())
    expect(hot.length).toBe(10)
    expect(new Set(hot).size).toBe(10)
    evidence.hotSearches = hot
    evidence.detail = await page.evaluate(async () => {
      const item = await window.panda.data.detail('db-26647087')
      return { id: item.id, title: item.title, score: item.score, cast: item.cast?.length, directors: item.directors, year: item.year, genres: item.genres, synopsis: Boolean(item.synopsis), backdrop: Boolean(item.backdrop), fabricatedEpisodes: item.episodes }
    })
    expect((evidence.detail as { fabricatedEpisodes?: number }).fabricatedEpisodes).toBeUndefined()
    evidence.related = await page.evaluate(async () => (await window.panda.data.related('db-26647087')).map(({ id, title }) => ({ id, title })))
    expect((evidence.related as unknown[]).length).toBeGreaterThan(0)
    await page.evaluate(() => { location.hash = '#/channel/anime?genre=校园' })
    await expect(page.locator('.filters')).toBeVisible()
    await expect(page.locator('.card').first()).toBeVisible()
    await capture(page, 'channel-live-campus')
    expect(errors).toEqual([])
  } finally {
    await mkdir(evidenceDir, { recursive: true })
    await writeFile(join(evidenceDir, `live-data-${process.env.PANDA_EVIDENCE_ROUND || '1'}.json`), JSON.stringify(evidence, null, 2))
    await app.close()
  }
})
