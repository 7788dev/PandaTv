// 可复用的界面片段（卡片、栏目、信息行、标签页…）。
// 每个函数返回的 HTML 结构就是手册〈组件〉一章里的结构，正式应用照此输出。
import { $, $$, esc, fmt, icon, img, tip, t, item, store, isSeries, statusText, progressText, episodeLabel } from './core.js'
import { toast } from './ui.js'

/** 信息行：评分 · 年份 · 类型 · 状态。缺哪项就不显示哪项 */
export function metaRow(it, { cls = '', region = false, max = 2 } = {}) {
  const parts = []
  if (it.score) parts.push(`<span class="meta__score">${it.score.toFixed(1)}</span>`)
  if (it.year) parts.push(`<span>${it.year}</span>`)
  if (region && it.region) parts.push(`<span>${esc(it.region)}</span>`)
  if (it.genres?.length) parts.push(`<span>${esc(it.genres.slice(0, max).join(' / '))}</span>`)
  const st = statusText(it)
  if (st) parts.push(`<span>${esc(st)}</span>`)
  return `<div class="meta ${cls}">${parts.join('')}</div>`
}

const media = (it, { wide = false, extra = '' } = {}) => {
  const src = wide ? it.backdrop || it.poster : it.poster
  return `<div class="card__media">
    ${src ? img(src, 'card__img') : `<span class="card__fallback">${esc(it.title)}</span>`}
    ${extra}
  </div>`
}

/** 卡片副标题：一句话卖点；没有就用类型；两样都没有就不输出这一行 */
const subLine = (it) => {
  const text = it.tagline || it.genres?.join(' / ')
  return text ? `<div class="card__sub">${esc(text)}</div>` : ''
}

/** 竖版海报卡片：点卡片进详情，悬停时右下角出现快捷播放 */
export function posterCard(it) {
  const st = statusText(it)
  return `<div class="card" data-id="${it.id}">
    <a class="card__link" href="#/detail/${it.id}">
      ${media(it, {
        extra: `${it.tag ? `<span class="tag">${esc(it.tag)}</span>` : ''}
          ${st ? `<span class="card__status">${esc(st)}</span>` : ''}
          ${it.score ? `<span class="card__score">${it.score.toFixed(1)}</span>` : ''}`,
      })}
      <div class="card__title">${esc(it.title)}</div>
      ${subLine(it)}
    </a>
    <div class="card__over">
      <a class="card__play" href="#/play/${it.id}" aria-label="${esc(t().action.play)}" tabindex="-1">${icon('play')}</a>
    </div>
  </div>`
}

/** 横版卡片（浏览用）：综艺、纪录片栏目 */
export function wideCard(it) {
  const st = statusText(it)
  return `<div class="card card--wide" data-id="${it.id}">
    <a class="card__link" href="#/detail/${it.id}">
      ${media(it, {
        wide: true,
        extra: `${it.tag ? `<span class="tag">${esc(it.tag)}</span>` : ''}
          ${st ? `<span class="card__status">${esc(st)}</span>` : ''}
          ${it.score ? `<span class="card__score">${it.score.toFixed(1)}</span>` : ''}`,
      })}
      <div class="card__title">${esc(it.title)}</div>
      ${subLine(it)}
    </a>
    <div class="card__over">
      <a class="card__play" href="#/play/${it.id}" aria-label="${esc(t().action.play)}" tabindex="-1">${icon('play')}</a>
    </div>
  </div>`
}

/** 继续观看卡片：整张卡片直接续播，带进度条和移除按钮 */
export function continueCard(h) {
  const it = item(h.id)
  if (!it) return ''
  const p = Math.min(100, Math.round((h.position / h.duration) * 100))
  return `<div class="card card--wide" data-id="${it.id}">
    <a class="card__link" href="#/play/${it.id}/${h.episode}">
      ${media(it, { wide: true, extra: `<span class="card__progress"><i style="--p:${p}%"></i></span>` })}
      <div class="card__title">${esc(it.title)}</div>
      <div class="card__sub">${esc(progressText(it, h))}</div>
    </a>
    <div class="card__over">
      <span class="card__play card__play--center" aria-hidden="true">${icon('play')}</span>
      <button class="card__remove" data-remove="${it.id}" ${tip(t().action.remove)}>${icon('close', 'sm')}</button>
    </div>
  </div>`
}

export const skeletonCard = (wide = false) =>
  `<div class="card${wide ? ' card--wide' : ''}" aria-hidden="true"><div class="card__media skel"></div><span class="skel skel--text"></span><span class="skel skel--text skel--short"></span></div>`

/** 横向栏目 */
export function shelf({ title, more, wide = false, cards, attrs = '' }) {
  return `<section class="section shelf${wide ? ' shelf--wide' : ''}" data-at-start ${attrs}>
    <header class="section__head">
      <h2 class="section__title">${esc(title)}</h2>
      ${more ? `<a class="text-btn" href="#${more}">${esc(t().action.more)}${icon('chevron-right')}</a>` : ''}
    </header>
    <div class="shelf__body">
      <div class="shelf__track">${cards.join('')}</div>
      <button class="shelf__nav shelf__nav--prev" aria-label="${esc(t().action.prev)}" tabindex="-1">${icon('chevron-left')}</button>
      <button class="shelf__nav shelf__nav--next" aria-label="${esc(t().action.next)}" tabindex="-1">${icon('chevron-right')}</button>
    </div>
  </section>`
}

const bound = new WeakSet()

/** 让栏目的箭头可用：整页翻动，到头的一侧箭头隐藏 */
export function bindShelves(root) {
  for (const el of $$('.shelf', root)) {
    if (bound.has(el)) continue
    bound.add(el)
    const track = $('.shelf__track', el)
    const sync = () => {
      el.toggleAttribute('data-at-start', track.scrollLeft < 4)
      el.toggleAttribute('data-at-end', track.scrollLeft + track.clientWidth > track.scrollWidth - 4)
    }
    const page = (dir) => {
      const cs = getComputedStyle(track)
      const gutter = parseFloat(cs.paddingLeft)
      const gap = parseFloat(cs.columnGap)
      track.scrollBy({ left: dir * (track.clientWidth - gutter * 2 + gap), behavior: 'smooth' })
    }
    $('.shelf__nav--prev', el).addEventListener('click', () => page(-1))
    $('.shelf__nav--next', el).addEventListener('click', () => page(1))
    track.addEventListener('scroll', sync, { passive: true })
    new ResizeObserver(sync).observe(track)
    sync()
  }
}

/** 标签页：把当前项的位置写进 Base UI 同名变量，竹节会滑过去
 *  variant: ''（默认，带竹节） | 'plain'（朴素，无竹节） | 'title'（标题级，带竹节） */
export function tabs(list, active, { variant = '', attr = 'data-tab' } = {}) {
  return `<div class="tabs${variant ? ` tabs--${variant}` : ''}" role="tablist">
    ${list.map(([value, label]) => `<button class="tabs__tab" role="tab" ${attr}="${esc(value)}" aria-selected="${value === active}"${value === active ? ' data-active' : ''}>${esc(label)}</button>`).join('')}
    ${variant === 'plain' ? '' : '<span class="tabs__indicator"></span>'}
  </div>`
}

/** instant：不要滑动（首次出现、窗口尺寸变化时）。Base UI 的 Tabs.Indicator 自带这个行为 */
export function syncTabs(el, instant = false) {
  const act = $('[data-active]', el)
  const ind = $('.tabs__indicator', el)
  if (!act || !ind) return
  if (instant) ind.style.transition = 'none'
  ind.style.setProperty('--active-tab-left', `${act.offsetLeft}px`)
  ind.style.setProperty('--active-tab-width', `${act.offsetWidth}px`)
  if (instant) {
    void ind.offsetWidth
    ind.style.transition = ''
  }
}

export function setTab(el, value, attr = 'data-tab') {
  for (const tab of $$('.tabs__tab', el)) {
    const on = tab.getAttribute(attr) === value
    tab.toggleAttribute('data-active', on)
    tab.setAttribute('aria-selected', on)
  }
  syncTabs(el)
}

/** 「收藏」按钮 */
export function favoriteButton(id, cls = 'btn--glass btn--lg') {
  const on = store.isFavorite(id)
  return `<button class="btn ${cls}" data-fav="${id}" aria-pressed="${on}"${on ? ' data-favorited' : ''}>${icon(on ? 'check' : 'plus')}<span>${esc(on ? t().action.favorited : t().action.favorite)}</span></button>`
}

/** 全局：处理收藏按钮、移除按钮（事件委托） */
export function initActions(onChange) {
  document.addEventListener('click', (e) => {
    const f = e.target.closest('[data-fav]')
    if (f) {
      const id = f.dataset.fav
      const on = store.toggleFavorite(id)
      // 页面上同一部片子的所有「收藏」按钮一起更新
      for (const b of $$(`[data-fav="${id}"]`)) b.outerHTML = favoriteButton(id, [...b.classList].filter((c) => c !== 'btn').join(' '))
      toast(on ? t().toast.favorited : t().toast.unfavorited)
      onChange?.('favorite', id)
      return
    }
    const r = e.target.closest('[data-remove]')
    if (r) {
      e.preventDefault()
      const id = r.dataset.remove
      const backup = { ...store.historyOf(id) }
      store.removeHistory(id)
      onChange?.('history', id)
      toast(t().toast.removed, {
        action: {
          label: t().action.undo,
          onClick: () => {
            store.state.history.push(backup)
            store.state.history.sort((a, b) => b.at - a.at)
            store.save()
            onChange?.('history', id)
          },
        },
      })
    }
  })
}

export const empty = (iconName, text, button = '') => `<div class="empty">${icon(iconName, 'xl')}<p class="empty__text">${esc(text)}</p>${button}</div>`

export { fmt, isSeries }
