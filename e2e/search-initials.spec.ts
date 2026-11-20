import { test, expect } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launch, evidenceDir } from './desktop'

test('real title initials search finds Chinese films in a new profile', async () => {
  const run = await launch()
  const { app, page, errors } = run
  const evidence = { at: new Date().toISOString(), cases: [] as unknown[] }
  try {
    for (const [query, expectedTitle] of [['LBXX', '蜡笔小新'], ['cqsl', '重庆森林'], ['ZHC', '甄嬛传'], ['AQZC', '阿Q正传']]) {
      const started = Date.now()
      const items = await page.evaluate(q => window.panda.data.search(q), query)
      const ms = Date.now() - started
      evidence.cases.push({ query, expectedTitle, searchMs: ms, results: items.map(({ id, title, type, year }) => ({ id, title, type, year })) })
      expect(items.some(item => item.title.includes(expectedTitle)), query).toBe(true)
      expect(new Set(items.map(item => item.id)).size, query).toBe(items.length)
      expect(items.every(item => /^db-\d+$/.test(item.id)), query).toBe(true)
      const suggestions = await page.evaluate(q => window.panda.data.suggest(q), query)
      expect(suggestions.some(item => item.title.includes(expectedTitle)), `${query} suggestions`).toBe(true)
      expect(suggestions.length).toBeLessThanOrEqual(8)
      Object.assign(evidence.cases.at(-1) as object, { suggestions: suggestions.map(({ id, title }) => ({ id, title })) })
    }
    const input = page.getByRole('combobox')
    await input.fill('LBXX')
    await expect(page.locator('.suggest__text').first()).toContainText('蜡笔小新')
    await input.press('Enter')
    await expect(page).toHaveURL(/#\/search\?q=LBXX$/)
    await expect(page.locator('.card__title').first()).toContainText('蜡笔小新')
    expect(errors).toEqual([])
  } finally {
    await writeFile(join(evidenceDir, `search-initials-live-${process.env.PANDA_EVIDENCE_ROUND || '1'}.json`), JSON.stringify({ ...evidence, diagnostics: run.logs.filter(log => /\[(metadata|startup|search)\]/.test(log)), errors }, null, 2) + '\n')
    await app.close()
  }
})
