// 原型外壳：顶栏、搜索、窗口按钮、整页滚动条、路由。
// 结构对应手册〈布局〉一章：
//   .app
//   ├─ header.topbar            （播放页没有顶栏）
//   ├─ .scroll.scroll--page     整页滚动容器，里面是当前页面
//   ├─ [播放页挂在这里]
//   └─ .winctl                  窗口按钮，永远在最上层
import { $, $$, esc, icon, tip, t, data, loadData, store, channelTitle, nav } from './core.js'
import { initActions, syncTabs } from './parts.js'
import { initTooltips } from './ui.js'
import * as views from './views.js'
import { player } from './player.js'
import { kit } from './kit.js'

const app = $('#app')
let topbar, scroll, viewport, bar, thumb, searchEl, field, input, panel

function shell() {
  const c = t()
  const channels = [['/', c.nav.home], ...data.catalog.channels.map((ch) => [`/channel/${ch.type}`, ch.title])]
  app.innerHTML = `<header class="topbar">
      <a class="topbar__logo" href="#/" aria-label="${esc(c.nav.home)}"><img src="/brand/logo-mark.svg" alt=""></a>
      <button class="icon-btn topbar__back" ${tip(c.action.back)} hidden>${icon('arrow-left')}</button>
      <nav class="nav">
        ${channels.map(([href, label]) => `<a class="nav__item" href="#${href}">${esc(label)}</a>`).join('')}
        <span class="nav__indicator"></span>
      </nav>
      <div class="topbar__spacer"></div>
      <div class="search" role="search">
        <label class="field">
          ${icon('search', 'sm', 'field__icon')}
          <input class="field__input" type="search" placeholder="${esc(c.search.placeholder)}" aria-label="${esc(c.search.label)}" autocomplete="off" spellcheck="false">
          <kbd class="kbd field__hint">Ctrl K</kbd>
          <button class="field__clear" type="button" aria-label="${esc(c.action.clearInput)}" tabindex="-1">${icon('close', 'sm')}</button>
        </label>
        <div class="search__panel"></div>
      </div>
      <div class="topbar__actions">
        <a class="icon-btn" href="#/me" ${tip(c.nav.me)}>${icon('user')}</a>
        <a class="icon-btn" href="#/settings" ${tip(c.nav.settings)}>${icon('settings')}</a>
      </div>
    </header>
    <div class="scroll scroll--page">
      <div class="scroll__viewport"></div>
      <div class="scroll__bar"><div class="scroll__thumb"></div></div>
    </div>
    <div class="winctl">
      <button class="winctl__btn" aria-label="${esc(c.window.minimize)}">${icon('win-min', 'sm')}</button>
      <button class="winctl__btn" aria-label="${esc(c.window.maximize)}" data-max>${icon('win-max', 'sm')}</button>
      <button class="winctl__btn winctl__btn--close" aria-label="${esc(c.window.close)}">${icon('win-close', 'sm')}</button>
    </div>`
  topbar = $('.topbar', app)
  scroll = $('.scroll', app)
  viewport = $('.scroll__viewport', app)
  bar = $('.scroll__bar', app)
  thumb = $('.scroll__thumb', app)
  searchEl = $('.search', app)
  field = $('.field', app)
  input = $('.field__input', app)
  panel = $('.search__panel', app)
}

// ───────────────────────── 竹节（当前频道的指示） ─────────────────────────
/** 把当前项的位置写进 --x / --w。instant：不要滑动（首次出现、窗口尺寸变化时） */
function syncNav(instant) {
  const ind = $('.nav__indicator', topbar)
  const cur = $('.nav__item[aria-current="page"]', topbar)
  if (!cur) return
  if (instant) ind.style.transition = 'none'
  ind.style.setProperty('--x', `${cur.offsetLeft}px`)
  ind.style.setProperty('--w', `${cur.offsetWidth}px`)
  if (instant) {
    void ind.offsetWidth
    ind.style.transition = ''
  }
}

const syncAllTabs = (root, instant) => $$('.tabs', root).forEach((el) => syncTabs(el, instant))

// ───────────────────────── 整页滚动条（模拟 Base UI ScrollArea） ─────────────────────────
let scrollingTimer = 0

function syncScroll() {
  const { scrollTop, scrollHeight, clientHeight } = viewport
  topbar.toggleAttribute('data-scrolled', scrollTop > 8)
  const overflow = scrollHeight - clientHeight
  bar.hidden = overflow <= 0
  if (overflow <= 0) return
  const track = bar.clientHeight
  const h = Math.max(40, (track * clientHeight) / scrollHeight)
  thumb.style.setProperty('--scroll-area-thumb-height', `${h}px`)
  thumb.style.translate = `0 ${((track - h) * scrollTop) / overflow}px`
}

function initScroll() {
  viewport.addEventListener(
    'scroll',
    () => {
      syncScroll()
      bar.setAttribute('data-scrolling', '')
      clearTimeout(scrollingTimer)
      scrollingTimer = setTimeout(() => bar.removeAttribute('data-scrolling'), 500)
    },
    { passive: true },
  )
  new ResizeObserver(syncScroll).observe(viewport)
  // 拖动滑块
  thumb.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    thumb.setPointerCapture(e.pointerId)
    const startY = e.clientY
    const startTop = viewport.scrollTop
    const ratio = (viewport.scrollHeight - viewport.clientHeight) / (bar.clientHeight - thumb.offsetHeight)
    const move = (ev) => (viewport.scrollTop = startTop + (ev.clientY - startY) * ratio)
    const up = () => {
      thumb.removeEventListener('pointermove', move)
      thumb.removeEventListener('pointerup', up)
    }
    thumb.addEventListener('pointermove', move)
    thumb.addEventListener('pointerup', up)
  })
  // 点轨道：翻一页
  bar.addEventListener('pointerdown', (e) => {
    if (e.target !== bar) return
    const dir = e.clientY < thumb.getBoundingClientRect().top ? -1 : 1
    viewport.scrollBy({ top: dir * viewport.clientHeight * 0.9, behavior: 'smooth' })
  })
}

// ───────────────────────── 搜索 ─────────────────────────
const searchHref = (q) => `#/search?q=${encodeURIComponent(q)}`

/** 片名里命中的那一段加亮 */
function highlight(title, q) {
  const i = title.toLowerCase().indexOf(q.toLowerCase())
  return i < 0 ? esc(title) : `${esc(title.slice(0, i))}<mark>${esc(title.slice(i, i + q.length))}</mark>${esc(title.slice(i + q.length))}`
}

function panelHTML(q) {
  const c = t()
  if (q) {
    // 有输入：联想。点一条直接进这部片子的详情
    return views
      .searchItems(q)
      .slice(0, 8)
      .map(
        (it) =>
          `<a class="suggest__item" href="#/detail/${it.id}" data-suggest="${esc(it.title)}">${icon('search', 'sm')}<span class="suggest__text">${highlight(it.title, q)}</span><span class="suggest__type">${esc(channelTitle(it.type))}</span></a>`,
      )
      .join('')
  }
  // 没有输入：最近搜索 + 热搜
  const recent = store.state.searches
  return `${
    recent.length
      ? `<div class="search__group">
          <div class="search__head"><span class="search__label">${esc(c.search.recent)}</span><button class="text-btn" data-clear-searches>${esc(c.action.clear)}</button></div>
          <div class="search__chips">${recent.map((s) => `<a class="chip chip--solid" href="${searchHref(s)}">${esc(s)}</a>`).join('')}</div>
        </div>`
      : ''
  }<div class="search__group">
      <div class="search__head"><span class="search__label">${esc(c.search.hot)}</span></div>
      <div class="hotlist">${data.catalog.hotSearches.map((s, i) => `<a class="hotlist__item" href="${searchHref(s)}"><span class="hotlist__rank">${i + 1}</span><span class="hotlist__title">${esc(s)}</span></a>`).join('')}</div>
    </div>`
}

function openSearch() {
  const html = panelHTML(input.value.trim())
  panel.innerHTML = html
  panel.scrollTop = 0
  searchEl.setAttribute('data-open', '')
  // 有输入但没有联想：不显示空面板
  panel.toggleAttribute('data-open', Boolean(html))
}

function closeSearch() {
  searchEl.removeAttribute('data-open')
  panel.removeAttribute('data-open')
}

function initSearch() {
  const rows = () => $$('.suggest__item, .hotlist__item', panel)
  input.addEventListener('focus', openSearch)
  input.addEventListener('input', () => {
    field.toggleAttribute('data-filled', Boolean(input.value))
    openSearch()
  })
  input.addEventListener('keydown', (e) => {
    const list = rows()
    const i = list.findIndex((r) => r.hasAttribute('data-highlighted'))
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!list.length) return
      e.preventDefault()
      const n = e.key === 'ArrowDown' ? (i + 1) % list.length : (i - 1 + list.length) % list.length
      list.forEach((r, k) => r.toggleAttribute('data-highlighted', k === n))
      list[n].scrollIntoView({ block: 'nearest' })
    } else if (e.key === 'Enter') {
      const q = input.value.trim()
      if (i >= 0) list[i].click()
      else if (q) location.hash = searchHref(q).slice(1)
    } else if (e.key === 'Escape') {
      closeSearch()
      input.blur()
    }
  })
  // 鼠标点面板时焦点留在输入框里
  panel.addEventListener('mousedown', (e) => e.preventDefault())
  panel.addEventListener('pointermove', () => rows().forEach((r) => r.removeAttribute('data-highlighted')))
  panel.addEventListener('click', (e) => {
    if (e.target.closest('[data-clear-searches]')) {
      store.state.searches = []
      store.save()
      return openSearch()
    }
    const s = e.target.closest('[data-suggest]')
    if (s) store.addSearch(s.dataset.suggest)
  })
  $('.field__clear', field).addEventListener('click', () => {
    input.value = ''
    field.removeAttribute('data-filled')
    input.focus()
    openSearch()
  })
  searchEl.addEventListener('focusout', (e) => searchEl.contains(e.relatedTarget) || closeSearch())
  document.addEventListener('pointerdown', (e) => searchEl.contains(e.target) || closeSearch(), true)
  document.addEventListener('keydown', (e) => {
    if (topbar.hidden) return
    const typing = e.target.matches?.('input, textarea')
    if ((e.key.toLowerCase() === 'k' && (e.ctrlKey || e.metaKey)) || (e.key === '/' && !typing)) {
      e.preventDefault()
      input.focus()
      input.select()
    }
  })
}

// ───────────────────────── 路由 ─────────────────────────
const positions = new Map() // 每条历史记录的滚动位置：返回时恢复
let current = { idx: 0, view: null, host: null }
let booted = false

function route() {
  const [path = '/', qs = ''] = (location.hash.slice(1) || '/').split('?')
  const query = new URLSearchParams(qs)

  if (booted) positions.set(current.idx, viewport.scrollTop)
  let st = history.state
  const fresh = !st || typeof st.idx !== 'number'
  if (fresh) {
    st = { idx: booted ? current.idx + 1 : 0 }
    history.replaceState(st, '')
  }
  current.view?.cleanup?.()
  current.host?.remove()
  current = { idx: st.idx, view: null, host: null }
  booted = true
  closeSearch()
  if (document.activeElement === input) input.blur()

  // 播放页：没有顶栏，不在滚动容器里
  const play = path.match(/^\/play\/([\w-]+)(?:\/(\d+))?$/)
  topbar.hidden = scroll.hidden = Boolean(play)
  if (play) {
    const host = document.createElement('div')
    app.insertBefore(host, $('.winctl', app))
    current.host = host
    current.view = player(host, play[1], Number(play[2]) || 0, query)
    return
  }

  // 顶栏状态
  const isChannel = path === '/' || path.startsWith('/channel/')
  $('.topbar__logo', topbar).hidden = !isChannel
  $('.topbar__back', topbar).hidden = isChannel
  for (const a of $$('.nav__item, .topbar__actions .icon-btn', topbar)) {
    const href = a.getAttribute('href').slice(1)
    const on = href === '/' ? path === '/' : path === href || path.startsWith(`${href}/`)
    if (on) a.setAttribute('aria-current', 'page')
    else a.removeAttribute('aria-current')
  }
  syncNav()
  const q = path === '/search' ? query.get('q') || '' : ''
  input.value = q
  field.toggleAttribute('data-filled', Boolean(q))

  // 页面
  const host = document.createElement('div')
  viewport.replaceChildren(host)
  let m
  if (path === '/') current.view = views.home(host)
  else if ((m = path.match(/^\/channel\/(\w+)$/))) current.view = views.channel(host, m[1], query)
  else if ((m = path.match(/^\/detail\/([\w-]+)$/))) current.view = views.detail(host, m[1])
  else if (path === '/search') {
    if (q) store.addSearch(q)
    current.view = views.search(host, q)
  } else if ((m = path.match(/^\/me(?:\/(\w+))?$/))) current.view = views.me(host, m[1])
  else if (path === '/settings') current.view = views.settings(host)
  else if (path === '/kit') current.view = kit(host)
  else current.view = views.notFound(host)

  syncAllTabs(host, true)
  viewport.scrollTop = fresh ? 0 : (positions.get(st.idx) ?? 0)
  syncScroll()
}

// ───────────────────────── 启动 ─────────────────────────
async function boot() {
  await loadData()
  store.init()
  shell()
  initScroll()
  initSearch()
  initTooltips()
  initActions((kind, id) => current.view?.refresh?.(kind, id))

  // 图片：加载完成后淡入；加载失败按「没有图片」处理
  document.addEventListener(
    'load',
    (e) => {
      if (e.target.matches?.('img.img')) e.target.setAttribute('data-loaded', '')
    },
    true,
  )
  document.addEventListener(
    'error',
    (e) => {
      const el = e.target
      if (!el.matches?.('img.img')) return
      const title = $('.card__title', el.closest('.card'))?.textContent
      if (title && el.matches('.card__img')) el.outerHTML = `<span class="card__fallback">${esc(title)}</span>`
      else el.remove()
    },
    true,
  )

  document.addEventListener('click', (e) => {
    if (e.target.closest('.topbar__back')) return nav.back()
    // data-replace：替换当前历史记录，而不是新增一条
    const a = e.target.closest('a[data-replace]')
    if (a) {
      e.preventDefault()
      return nav.replace(a.getAttribute('href'))
    }
    // 窗口按钮在浏览器里只是摆设；最大化按钮演示一下图标切换
    const max = e.target.closest('[data-max]')
    if (max) {
      const on = max.toggleAttribute('data-maximized')
      max.innerHTML = icon(on ? 'win-restore' : 'win-max', 'sm')
      max.setAttribute('aria-label', on ? t().window.restore : t().window.maximize)
    }
  })

  addEventListener('hashchange', route)
  addEventListener('resize', () => {
    syncNav(true)
    syncAllTabs(viewport, true)
  })
  route()
  syncNav(true)
  // 字体加载完成后文字宽度会变，竹节重新对位
  document.fonts.ready.then(() => {
    syncNav(true)
    syncAllTabs(viewport, true)
  })
}

boot()
