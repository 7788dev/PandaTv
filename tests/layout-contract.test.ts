import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(resolve('src/renderer/app.css'), 'utf8')

const block = (selector: string) => {
  const indented = css.indexOf(`\n  ${selector} {`)
  const start = indented >= 0 ? indented + 1 : css.indexOf(`${selector} {`)
  expect(start, selector).toBeGreaterThanOrEqual(0)
  const end = css.indexOf('}', start)
  expect(end, selector).toBeGreaterThan(start)
  return css.slice(start, end + 1)
}

describe('desktop layout contract', () => {
  it('uses spacing tokens for the repaired component gaps', () => {
    const selectors = [
      '.hero__kicker', '.hero__pager', '.hero__actions', '.card__status', '.card__score', '.card__title',
      '.rank__item', '.eps', '.cast__avatar', '.filters', '.detail__orig', '.detail__meta', '.detail__more',
      '.credits', '.dialog', '.dialog__actions', '.menu', '.tooltip', '.nav__item', '.search__head',
      '.search__chips', '.field', '.select', '.btn', '.btn--lg', '.btn--sm', '.chip', '.tag', '.kbd',
    ]
    for (const selector of selectors) {
      const rule = block(selector)
      expect(rule, selector).toContain('var(--sp-')
      expect(rule, selector).not.toMatch(/(?:padding|margin|gap)[^;{}]*:\s*\d+px/)
    }
  })

  it('keeps the compact and wide breakpoints for hero, detail, player and episodes', () => {
    expect(css).toContain('.hero__thumb { width: clamp(64px, 6.4vw, 92px); }')
    expect(css).toContain('@media (max-height: 720px)')
    expect(css).toContain('.hero__title { font-size: clamp(32px, 3.6vw, 44px); line-height: 1.2; }')
    expect(css).toContain('@media (max-width: 1200px)')
    expect(css).toContain('.detail__head { grid-template-columns: clamp(168px, 18vw, 220px) minmax(0, 1fr);')
    expect(css).toContain('@media (max-width: 1240px)')
    expect(css).toContain('.player__bar { gap: var(--sp-2); }')
    expect(css).toContain('@media (min-width: 2000px)')
    expect(css).toContain('.eplist--cols { grid-template-columns: repeat(4, minmax(0, 1fr)); }')
    expect(css).toContain('.cast__item { width: 88px; }')
    expect(css).toContain('@media (min-width: 2400px)')
    expect(css).toContain('.eplist--cols { grid-template-columns: repeat(5, minmax(0, 1fr)); }')
  })

  it('keeps the wide feature poster and rank spacing on their tokens', () => {
    expect(css).toContain('.feature { grid-template-columns: clamp(148px, 8vw, 200px) minmax(0, 1fr); }')
    const rank = block('.rank__item')
    expect(rank).toContain('gap: var(--sp-3)')
  })
})