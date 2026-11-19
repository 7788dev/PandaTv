import { test, expect } from '@playwright/test'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { launch, capture, evidenceDir } from './desktop'

// 三体 (2023): Douban credits 68 actors on it; before this the page listed all of them, without photos.
const TITLE = 'db-26647087'

test('real Douban people: the few a title is known for, their photos, and everything one of them worked on', async () => {
  test.setTimeout(240000)
  const { app, page, errors } = await launch()
  const evidence: Record<string, unknown> = { at: new Date().toISOString() }
  try {
    await expect(page.locator('.hero__title')).toBeVisible()
    await page.evaluate(id => { location.hash = `#/detail/${id}` }, TITLE)
    await expect(page.locator('.detail__title')).toHaveText('三体')
    await expect(page.locator('.cast .cast__item').first()).toBeVisible()
    const detail = await page.evaluate(async id => {
      const item = await window.panda.data.detail(id)
      return { directors: item.directors, cast: item.cast, people: (item.people ?? []).map(({ id, name, role, photo }) => ({ id, name, role, photo: Boolean(photo) })) }
    }, TITLE)
    evidence.detail = detail
    // The few people Douban puts on the title's own page, each of them once.
    expect(detail.people.length).toBeGreaterThanOrEqual(3)
    expect(detail.people.length).toBeLessThanOrEqual(8)
    expect(new Set(detail.people.map(person => person.id)).size).toBe(detail.people.length)
    expect(detail.cast!.length).toBeLessThanOrEqual(6)
    await expect(page.locator('.cast .cast__item')).toHaveCount(detail.people.length)
    await expect(page.locator('.credits dd').nth(1)).toHaveText(detail.cast!.map(person => person.name).join(' / '))
    // Their photos decode in the real window, through the media proxy.
    const withPhoto = detail.people.filter(person => person.photo).length
    expect(withPhoto).toBeGreaterThanOrEqual(detail.people.length - 1)
    await page.locator('.cast').scrollIntoViewIfNeeded()
    await expect(page.locator('.cast__avatar .img[data-loaded]')).toHaveCount(withPhoto, { timeout: 30000 })
    evidence.photos = await page.locator('.cast__avatar .img').evaluateAll(images => images.map(image => ({ width: (image as HTMLImageElement).naturalWidth, height: (image as HTMLImageElement).naturalHeight })))
    expect((evidence.photos as { width: number }[]).every(photo => photo.width > 0)).toBe(true)
    await capture(page, 'detail-people')

    // Someone on that list leads to everything they worked on. A placeholder card has no identity.
    const works = page.locator('.card[data-id]')
    const who = detail.people.find(person => person.name === '于和伟') ?? detail.people[1]!
    const clicked = Date.now()
    await page.locator(`.cast a[href="#/person/${who.id}"]`).click()
    await expect(page.locator('.page__title')).toHaveText(who.name)
    await expect(page.locator('.page__head .cast__avatar .img[data-loaded]')).toHaveCount(who.photo ? 1 : 0)
    await expect(works.first()).toBeVisible({ timeout: 60000 })
    const firstPage = await works.count()
    evidence.person = { id: who.id, name: who.name, firstPage, firstPageMs: Date.now() - clicked }
    expect(firstPage).toBeGreaterThan(0)
    expect(firstPage).toBeLessThanOrEqual(30)
    await expect(page.locator('.card[data-id] .card__img[data-loaded]').first()).toBeVisible({ timeout: 30000 })
    await capture(page, 'person-works')
    // The end of the list coming into view adds the next page.
    await page.evaluate(() => { const view = document.querySelector('.scroll--page .scroll__viewport')!; view.scrollTop = view.scrollHeight })
    await expect.poll(() => works.count(), { timeout: 60000 }).toBeGreaterThan(firstPage)
    // The whole list, read the way the page reads it: every work once, up to the end.
    const walked = await page.evaluate(async id => {
      const ids: string[] = [], pages: number[] = []
      let cursor: string | undefined
      const started = Date.now()
      do {
        const result = await window.panda.data.personWorks(id, cursor)
        ids.push(...result.items.map(item => item.id)); pages.push(result.items.length)
        cursor = result.next ?? undefined
      } while (cursor && pages.length < 30)
      return { pages, works: ids.length, distinct: new Set(ids).size, ended: !cursor, ms: Date.now() - started }
    }, who.id!)
    evidence.works = walked
    expect(walked.ended).toBe(true)
    expect(walked.distinct).toBe(walked.works)
    expect(walked.works).toBeGreaterThan(30)

    // A work on the list opens like any other title, and going back returns to the list.
    const opened = await works.first().locator('.card__title').textContent()
    await works.first().locator('.card__link').click()
    await expect(page.locator('.detail__title')).toHaveText(opened!)
    await page.getByRole('button', { name: '返回', exact: true }).click()
    await expect(page.locator('.page__title')).toHaveText(who.name)
    await page.getByRole('button', { name: '返回', exact: true }).click()
    await expect(page.locator('.detail__title')).toHaveText('三体')

    // Someone Douban does not know is said to be a person who was not found.
    await page.evaluate(() => { location.hash = '#/person/9999999999' })
    await expect(page.locator('.empty__text')).toHaveText('未找到这位影人')
    expect(errors).toEqual([])
  } finally {
    await mkdir(evidenceDir, { recursive: true })
    await writeFile(join(evidenceDir, `live-people-${process.env.PANDA_EVIDENCE_ROUND || '1'}.json`), JSON.stringify(evidence, null, 2))
    await app.close()
  }
})
