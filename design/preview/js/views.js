// 各页面：首页、频道、详情、搜索结果、我的、设置。
// 每个函数把页面渲染进 el（每次导航都是一个全新的容器），可选地返回 { refresh, cleanup }。
// 这里输出的 HTML 结构就是手册〈页面〉一章里的结构。
import { $, $$, esc, fmt, icon, img, t, data, item, store, isSeries, isFinished, continuing, episodeLabel, channelTitle, speedLabel, SPEEDS, QUALITIES } from './core.js'
import { metaRow, posterCard, wideCard, continueCard, shelf, bindShelves, tabs, syncTabs, setTab, favoriteButton, empty } from './parts.js'
import { openMenu, confirmDialog, toast } from './ui.js'

/** 静态海报框。没有海报时：大尺寸竖排片名，小尺寸（榜单缩略图）只留底色 */
const posterBox = (it, cls, { fallback = true } = {}) =>
  `<div class="poster ${cls}">${it.poster ? img(it.poster, '', 'loading="eager"') : fallback ? `<span class="card__fallback">${esc(it.title)}</span>` : ''}</div>`

/** 让容器里的内容重新淡入（React 里的做法是给容器换一个 key） */
function replay(box) {
  box.classList.remove('fade-in')
  void box.offsetWidth
  box.classList.add('fade-in')
}

// ───────────────────────── 首页 ─────────────────────────
function heroBody(it) {
  const c = t()
  return `<div class="hero__body">
    ${it.kicker ? `<div class="hero__kicker">${esc(it.kicker)}</div>` : ''}
    <h1 class="hero__title">${esc(it.title)}</h1>
    ${metaRow(it, { cls: 'hero__meta' })}
    ${it.tagline || it.synopsis ? `<p class="hero__tagline">${esc(it.tagline || it.synopsis)}</p>` : ''}
    <div class="hero__actions">
      <a class="btn btn--primary btn--lg" href="#/play/${it.id}">${icon('play')}${esc(c.action.play)}</a>
      <a class="btn btn--glass btn--lg" href="#/detail/${it.id}">${esc(c.action.detail)}</a>
    </div>
  </div>`
}

function hero(items) {
  return `<section class="hero">
    ${items
      .map(
        (it, i) =>
          `<div class="hero__slide"${i === 0 ? ' data-active' : ''}>${it.backdrop ? img(it.backdrop, 'hero__img', 'loading="eager"') : img(it.poster, 'hero__img', 'data-ambient loading="eager"')}</div>`,
      )
      .join('')}
    <div class="hero__shade"></div>
    ${heroBody(items[0])}
    <div class="hero__pager">
      ${items
        .map(
          (it, i) =>
            `<button class="hero__thumb" aria-label="${esc(it.title)}"${i === 0 ? ' data-active' : ''}>${img(it.backdrop || it.poster, '', 'loading="eager"')}<i class="hero__timer"></i></button>`,
        )
        .join('')}
    </div>
  </section>`
}

function mountHero(root, items) {
  const slides = $$('.hero__slide', root)
  const thumbs = $$('.hero__thumb', root)
  let index = 0
  const show = (n) => {
    index = (n + items.length) % items.length
    slides.forEach((s, k) => s.toggleAttribute('data-active', k === index))
    thumbs.forEach((s, k) => s.toggleAttribute('data-active', k === index))
    $('.hero__body', root).outerHTML = heroBody(items[index]) // 换一个新节点，入场动画重新播放（React：key={id}）
  }
  thumbs.forEach((el, k) => el.addEventListener('click', () => k !== index && show(k)))
  // 计时线走完 → 下一张。鼠标悬停、或键盘焦点在主推区里时 CSS 暂停动画，等于暂停轮播
  root.addEventListener('animationend', (e) => e.animationName === 'hero-timer' && show(index + 1))
  root.addEventListener('pointerenter', () => root.setAttribute('data-paused', ''))
  root.addEventListener('pointerleave', () => root.contains(document.activeElement) || root.removeAttribute('data-paused'))
  root.addEventListener('focusin', (e) => e.target.matches(':focus-visible') && root.setAttribute('data-paused', ''))
  root.addEventListener('focusout', () => root.matches(':hover') || root.removeAttribute('data-paused'))
}

function rank(s) {
  return `<section class="section rank">
    ${s.boards
      .map(
        (b) => `<div class="rank__col">
          <h2 class="rank__title">${esc(b.title)}</h2>
          <ol class="rank__list">
            ${b.items
              .map(item)
              .filter(Boolean)
              .map(
                (it, i) => `<li><a class="rank__item" href="#/detail/${it.id}">
                  <span class="rank__num">${i + 1}</span>
                  ${posterBox(it, 'rank__thumb', { fallback: false })}
                  <span class="rank__text"><span class="rank__name">${esc(it.title)}</span><span class="rank__sub">${esc([it.genres?.[0], it.year].filter(Boolean).join(' · '))}</span></span>
                  ${it.score ? `<span class="rank__score">${it.score.toFixed(1)}</span>` : ''}
                </a></li>`,
              )
              .join('')}
          </ol>
        </div>`,
      )
      .join('')}
  </section>`
}

export function home(el) {
  const c = data.catalog
  const heroItems = c.home.hero.map(item).filter(Boolean)
  // 「继续观看」不是服务端栏目：由本地观看历史里还没看完的条目生成；一条都没有时整个栏目不出现
  const continueShelf = () => {
    const hs = continuing()
    return hs.length ? shelf({ title: t().home.continue, more: '/me/history', wide: true, cards: hs.map(continueCard), attrs: 'data-continue' }) : ''
  }
  const shelves = c.home.shelves.map((s) => {
    if (s.kind === 'continue') return continueShelf()
    if (s.kind === 'rank') return rank(s)
    const wide = s.kind === 'wide'
    return shelf({ title: s.title, more: s.more, wide, cards: s.items.map(item).filter(Boolean).map(wide ? wideCard : posterCard) })
  })
  el.innerHTML = `<main class="page page--bleed">${hero(heroItems)}${shelves.join('')}</main>`
  bindShelves(el)
  mountHero($('.hero', el), heroItems)
  return {
    refresh(kind) {
      if (kind !== 'history') return
      const old = $('[data-continue]', el)
      const ids = continuing().map((h) => h.id)
      const cards = old ? $$('.card', old) : []
      const shown = cards.map((x) => x.dataset.id)
      if (old && ids.length && ids.every((id) => shown.includes(id))) {
        // 只是少了几项：把对应卡片拿掉，其余原地不动
        cards.forEach((x) => ids.includes(x.dataset.id) || x.remove())
      } else if (old) old.outerHTML = continueShelf()
      else $('.hero', el).insertAdjacentHTML('afterend', continueShelf())
      bindShelves(el)
    },
  }
}

// ───────────────────────── 频道 ─────────────────────────
export function channel(el, type, query = new URLSearchParams()) {
  const c = t().channel
  const filters = data.catalog.filters[type]
  if (!filters) return notFound(el)
  const all = data.catalog.items.filter((it) => it.type === type)
  // 筛选条件写在地址里（?genre=悬疑&sort=new），从详情页返回时自然恢复
  const state = { genre: query.get('genre') || '', region: query.get('region') || '', year: query.get('year') || '', sort: query.get('sort') || 'hot' }
  const row = (key, label, values) => `<div class="filters__row" role="group" aria-label="${esc(label)}">
      <span class="filters__label">${esc(label)}</span>
      <div class="filters__chips">
        ${[['', c.all], ...values.map((v) => [v, v])].map(([v, text]) => `<button class="chip" data-filter="${key}" data-value="${esc(v)}" aria-pressed="${state[key] === v}">${esc(text)}</button>`).join('')}
      </div>
    </div>`
  el.innerHTML = `<main class="page">
    <header class="page__head">
      <h1 class="page__title">${esc(channelTitle(type))}</h1>
      <div class="page__tools">${tabs([['hot', c.sortHot], ['new', c.sortNew], ['score', c.sortScore]], state.sort, { variant: 'plain', attr: 'data-sort' })}</div>
    </header>
    <div class="filters">
      ${row('genre', c.genre, filters.genres)}
      ${filters.regions.length > 1 ? row('region', c.region, filters.regions) : ''}
      ${row('year', c.year, filters.years)}
    </div>
    <div data-list></div>
  </main>`
  const list = $('[data-list]', el)
  const years = filters.years.filter((y) => /^\d+$/.test(y)).map(Number)
  const apply = (animate) => {
    let rows = all.filter(
      (it) =>
        (!state.genre || it.genres.includes(state.genre)) &&
        (!state.region || it.region === state.region) &&
        (!state.year || (/^\d+$/.test(state.year) ? it.year === Number(state.year) : it.year < Math.min(...years))),
    )
    if (state.sort === 'new') rows = [...rows].sort((a, b) => b.year - a.year)
    if (state.sort === 'score') rows = [...rows].sort((a, b) => (b.score || 0) - (a.score || 0))
    list.innerHTML = rows.length
      ? `<div class="grid grid--poster">${rows.map(posterCard).join('')}</div><p class="list-end">${esc(c.end)}</p>`
      : empty('film', c.empty, `<button class="btn" data-clear>${esc(t().action.clearFilters)}</button>`)
    if (!animate) return
    replay(list)
    const qs = new URLSearchParams(Object.entries(state).filter(([k, v]) => v && !(k === 'sort' && v === 'hot'))).toString()
    history.replaceState(history.state, '', `#/channel/${type}${qs ? `?${qs}` : ''}`)
  }
  el.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-filter]')
    if (chip) {
      state[chip.dataset.filter] = chip.dataset.value
      for (const s of $$(`[data-filter="${chip.dataset.filter}"]`, el)) s.setAttribute('aria-pressed', s === chip)
      return apply(true)
    }
    const sort = e.target.closest('[data-sort]')
    if (sort) {
      state.sort = sort.dataset.sort
      setTab(sort.parentElement, state.sort, 'data-sort')
      return apply(true)
    }
    if (e.target.closest('[data-clear]')) {
      Object.assign(state, { genre: '', region: '', year: '' })
      for (const s of $$('[data-filter]', el)) s.setAttribute('aria-pressed', s.dataset.value === '')
      apply(true)
    }
  })
  apply(false)
}

// ───────────────────────── 详情 ─────────────────────────
const overlap = (a, b) => a.genres.filter((g) => b.genres.includes(g)).length

/** 选集的内容：数字格子，或带标题的列表。详情页和播放页的选集面板共用 */
export function episodeCells(it, current, { from = 1, to = it.episodes, replace = false } = {}) {
  const state = (n) => (n === current ? ' data-current aria-current="true"' : current && n < current ? ' data-watched' : '')
  const link = (n) => `href="#/play/${it.id}/${n}"${replace ? ' data-replace' : ''}`
  const nums = Array.from({ length: to - from + 1 }, (_, k) => from + k)
  if (it.episodeTitles)
    return nums
      .map((n) => `<a class="eplist__item" ${link(n)}${state(n)}><span class="eplist__num">${esc(episodeLabel(it, n))}</span><span class="eplist__title">${esc(it.episodeTitles[n - 1] || '')}</span></a>`)
      .join('')
  return nums.map((n) => `<a class="ep" ${link(n)} aria-label="${esc(episodeLabel(it, n))}"${state(n)}>${n}</a>`).join('')
}

export function detail(el, id) {
  const it = item(id)
  if (!it) return notFound(el)
  const c = t()
  const h = store.historyOf(id)
  const series = isSeries(it)
  // 主按钮：没看过 → 播放；多集 → 继续播放 第N集；单片没看完 → 继续播放，看完了 → 播放（会从头开始）
  const playLabel = !h ? c.action.play : series ? fmt(c.action.resumeEpisode, { n: h.episode, unit: it.unit }) : isFinished(h) ? c.action.play : c.action.resume
  const count = it.episodes || 0

  // 超过 50 集的剧，按 50 集一段分开，默认停在正在看的那一段
  const size = 50
  const ranges = []
  for (let a = 1; a <= count; a += size) ranges.push([a, Math.min(count, a + size - 1)])
  const first = ranges.find(([a, b]) => h && h.episode >= a && h.episode <= b) || ranges[0]
  const episodes = series
    ? `<section class="section">
        <header class="section__head">
          <h2 class="section__title">${esc(c.detail.episodes)}</h2>
          ${ranges.length > 1 ? tabs(ranges.map(([a, b]) => [`${a}-${b}`, fmt(c.status.range, { a, b })]), `${first[0]}-${first[1]}`, { variant: 'plain', attr: 'data-range' }) : ''}
        </header>
        <div class="section__body"><div class="${it.episodeTitles ? 'eplist eplist--cols' : 'eps'}" data-eps>${episodeCells(it, h?.episode, { from: first[0], to: first[1] })}</div></div>
      </section>`
    : ''

  const related = data.catalog.items.filter((x) => x.id !== id && x.type === it.type).sort((a, b) => overlap(b, it) - overlap(a, it))

  el.innerHTML = `<main class="page page--bleed">
    <div class="detail__backdrop">
      ${it.backdrop ? img(it.backdrop, 'detail__bg', 'loading="eager"') : img(it.poster, 'detail__bg', 'data-ambient loading="eager"')}
      <div class="detail__shade"></div>
    </div>
    <div class="detail__head">
      ${posterBox(it, 'detail__poster')}
      <div class="detail__info">
        <h1 class="detail__title">${esc(it.title)}</h1>
        ${it.originalTitle ? `<div class="detail__orig">${esc(it.originalTitle)}</div>` : ''}
        ${metaRow(it, { cls: 'detail__meta', region: true, max: 3 })}
        <div class="detail__actions">
          <a class="btn btn--primary btn--lg" href="#/play/${id}${h ? `/${h.episode}` : ''}">${icon('play')}${esc(playLabel)}</a>
          ${favoriteButton(id)}
        </div>
        ${
          it.synopsis
            ? `<p class="detail__synopsis" data-clamped>${esc(it.synopsis)}</p>
               <button class="text-btn detail__more" data-more hidden>${esc(c.action.expand)}</button>`
            : ''
        }
        ${
          it.directors?.length || it.cast?.length
            ? `<dl class="credits">
                ${it.directors?.length ? `<div><dt>${esc(c.detail.director)}</dt><dd>${esc(it.directors.join(' / '))}</dd></div>` : ''}
                ${it.cast?.length ? `<div><dt>${esc(c.detail.starring)}</dt><dd>${esc(it.cast.map((p) => p.name).join(' / '))}</dd></div>` : ''}
              </dl>`
            : ''
        }
      </div>
    </div>
    ${episodes}
    ${
      it.cast?.length
        ? `<section class="section">
            <header class="section__head"><h2 class="section__title">${esc(c.detail.cast)}</h2></header>
            <div class="section__body"><ul class="cast">
              ${it.cast.map((p) => `<li class="cast__item"><span class="cast__avatar">${esc([...p.name][0])}</span><span class="cast__name">${esc(p.name)}</span>${p.role ? `<span class="cast__role">${esc(p.role)}</span>` : ''}</li>`).join('')}
            </ul></div>
          </section>`
        : ''
    }
    ${related.length ? shelf({ title: c.detail.related, cards: related.slice(0, 14).map(posterCard) }) : ''}
  </main>`
  bindShelves(el)

  // 简介超过三行才出现「展开」
  const syn = $('.detail__synopsis', el)
  const more = $('[data-more]', el)
  if (syn)
    requestAnimationFrame(() => {
      if (syn.scrollHeight > syn.clientHeight + 2) more.hidden = false
    })
  el.addEventListener('click', (e) => {
    if (e.target.closest('[data-more]')) {
      const clamped = syn.toggleAttribute('data-clamped')
      more.textContent = clamped ? c.action.expand : c.action.collapse
      return
    }
    const r = e.target.closest('[data-range]')
    if (r) {
      setTab(r.parentElement, r.dataset.range, 'data-range')
      const [a, b] = r.dataset.range.split('-').map(Number)
      const box = $('[data-eps]', el)
      box.innerHTML = episodeCells(it, h?.episode, { from: a, to: b })
      replay(box)
    }
  })
}

// ───────────────────────── 搜索结果 ─────────────────────────
export const searchItems = (q) => {
  const k = q.trim().toLowerCase()
  if (!k) return []
  const hit = (s) => String(s || '').toLowerCase().includes(k)
  return data.catalog.items
    .map((it) => ({
      it,
      rank: hit(it.title) ? 0 : hit(it.originalTitle) ? 1 : it.genres.some(hit) || hit(channelTitle(it.type)) ? 2 : it.directors?.some(hit) || it.cast?.some((p) => hit(p.name)) ? 3 : -1,
    }))
    .filter((r) => r.rank >= 0)
    .sort((a, b) => a.rank - b.rank)
    .map((r) => r.it)
}

export function search(el, q) {
  const c = t()
  const all = searchItems(q)
  const present = data.catalog.channels.filter((ch) => all.some((it) => it.type === ch.type))
  const types = [['', c.search.all], ...present.map((ch) => [ch.type, ch.title])]
  el.innerHTML = `<main class="page">
    <header class="page__head">
      <div class="page__heading">
        <div class="page__kicker">${esc(c.search.results)}</div>
        <h1 class="page__title">${esc(q)}</h1>
      </div>
      ${present.length > 1 ? `<div class="page__tools">${tabs(types, '', { variant: 'plain', attr: 'data-type' })}</div>` : ''}
    </header>
    <div data-list></div>
  </main>`
  const list = $('[data-list]', el)
  const apply = (type) => {
    const rows = type ? all.filter((it) => it.type === type) : all
    if (!rows.length) return (list.innerHTML = empty('search-x', c.search.empty))
    const [best, ...rest] = rows
    // 片名直接命中时，第一条放大成「最佳匹配」
    const exact = best.title.toLowerCase().includes(q.trim().toLowerCase())
    const feature = exact
      ? `<div class="feature">
          <a class="poster feature__poster" href="#/detail/${best.id}" tabindex="-1">${best.poster ? img(best.poster) : `<span class="card__fallback">${esc(best.title)}</span>`}</a>
          <div>
            <h2 class="feature__title"><a href="#/detail/${best.id}">${esc(best.title)}</a></h2>
            ${metaRow(best, { cls: 'feature__meta', region: true })}
            ${best.synopsis || best.tagline ? `<p class="feature__tagline">${esc(best.synopsis || best.tagline)}</p>` : ''}
            <div class="feature__actions">
              <a class="btn btn--primary" href="#/play/${best.id}">${icon('play')}${esc(c.action.play)}</a>
              <a class="btn" href="#/detail/${best.id}">${esc(c.action.detail)}</a>
            </div>
          </div>
        </div>`
      : ''
    const cards = exact ? rest : rows
    list.innerHTML = `${feature}${cards.length ? `<div class="grid grid--poster">${cards.map(posterCard).join('')}</div>` : ''}`
  }
  el.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-type]')
    if (!tab) return
    setTab(tab.parentElement, tab.dataset.type, 'data-type')
    apply(tab.dataset.type)
    replay(list)
  })
  apply('')
}

// ───────────────────────── 我的 ─────────────────────────
export function me(el, tab) {
  const c = t()
  if (tab !== 'history') tab = 'favorites'
  const body = () => {
    if (tab === 'favorites') {
      const rows = store.state.favorites.map(item).filter(Boolean)
      return rows.length ? `<div class="grid grid--poster">${rows.map(posterCard).join('')}</div>` : empty('bookmark', c.me.emptyFavorites)
    }
    const hs = store.state.history
    if (!hs.length) return empty('history', c.me.emptyHistory)
    const day = 86400000
    const start = new Date().setHours(0, 0, 0, 0)
    const groups = [
      [c.me.today, hs.filter((h) => h.at >= start)],
      [c.me.yesterday, hs.filter((h) => h.at < start && h.at >= start - day)],
      [c.me.earlier, hs.filter((h) => h.at < start - day)],
    ].filter(([, rows]) => rows.length)
    return groups.map(([label, rows]) => `<section class="group"><h2 class="group__label">${esc(label)}</h2><div class="grid grid--wide">${rows.map(continueCard).join('')}</div></section>`).join('')
  }
  el.innerHTML = `<main class="page">
    <header class="page__head">
      ${tabs([['favorites', c.me.favorites], ['history', c.me.history]], tab, { variant: 'title', attr: 'data-me' })}
      <div class="page__tools"><button class="text-btn" data-clear-history hidden>${esc(c.action.clear)}</button></div>
    </header>
    <div data-list></div>
  </main>`
  const list = $('[data-list]', el)
  const clearBtn = $('[data-clear-history]', el)
  const paint = (animate) => {
    list.innerHTML = body()
    clearBtn.hidden = !(tab === 'history' && store.state.history.length)
    if (animate) replay(list)
  }
  paint(false)
  el.addEventListener('click', async (e) => {
    const m = e.target.closest('[data-me]')
    if (m && m.dataset.me !== tab) {
      tab = m.dataset.me
      history.replaceState(history.state, '', tab === 'history' ? '#/me/history' : '#/me')
      setTab(m.parentElement, tab, 'data-me')
      return paint(true)
    }
    if (e.target.closest('[data-clear-history]')) {
      const ok = await confirmDialog({ title: c.me.clearHistoryTitle, confirm: c.action.clear, danger: true })
      if (!ok) return
      store.state.history = []
      store.save()
      paint(true)
      toast(c.toast.cleared)
    }
  })
  return {
    refresh(kind) {
      if (kind !== 'history' || tab !== 'history') return
      const ids = store.state.history.map((h) => h.id)
      const cards = $$('.card', list)
      const shown = cards.map((x) => x.dataset.id)
      if (ids.length && ids.every((id) => shown.includes(id))) {
        // 只是少了几项：拿掉对应卡片；某个分组空了就连分组一起拿掉
        cards.forEach((x) => ids.includes(x.dataset.id) || x.remove())
        $$('.group', list).forEach((g) => $('.card', g) || g.remove())
      } else paint(false)
      clearBtn.hidden = !store.state.history.length
    },
  }
}

// ───────────────────────── 设置 ─────────────────────────
export function settings(el) {
  const c = t()
  const s = store.state.settings
  const sw = (key) => `<button class="switch" role="switch" aria-checked="${s[key]}" aria-label="${esc(c.settings[key])}" data-switch="${key}"${s[key] ? ' data-checked' : ' data-unchecked'}><span class="switch__thumb"></span></button>`
  const select = (key, text) => `<button class="select" aria-label="${esc(c.settings[key])}" data-select="${key}"><span>${esc(text)}</span>${icon('chevron-down', 'sm')}</button>`
  el.innerHTML = `<main class="page">
    <header class="page__head"><h1 class="page__title">${esc(c.settings.title)}</h1></header>
    <div class="settings__body">
      <section class="setgroup">
        <h2 class="setgroup__label">${esc(c.settings.playback)}</h2>
        <div class="setrow"><span class="setrow__label">${esc(c.settings.autoNext)}</span>${sw('autoNext')}</div>
        <div class="setrow"><span class="setrow__label">${esc(c.settings.skipIntro)}</span>${sw('skipIntro')}</div>
        <div class="setrow"><span class="setrow__label">${esc(c.settings.quality)}</span>${select('quality', s.quality)}</div>
        <div class="setrow"><span class="setrow__label">${esc(c.settings.speed)}</span>${select('speed', speedLabel(s.speed))}</div>
      </section>
      <section class="setgroup">
        <h2 class="setgroup__label">${esc(c.settings.data)}</h2>
        <div class="setrow"><span class="setrow__label">${esc(c.settings.clearHistory)}</span><button class="btn btn--sm" data-clear="history">${esc(c.action.clear)}</button></div>
        <div class="setrow"><span class="setrow__label">${esc(c.settings.clearSearches)}</span><button class="btn btn--sm" data-clear="searches">${esc(c.action.clear)}</button></div>
      </section>
      <section class="setgroup">
        <h2 class="setgroup__label">${esc(c.settings.about)}</h2>
        <div class="about">
          <img class="about__mark" src="/brand/logo-mark.svg" alt="">
          <div><div class="about__name">${esc(c.app.name)}</div><div class="about__version">${esc(fmt(c.app.version, { v: '1.0.0' }))}</div></div>
          <button class="btn btn--sm" data-update>${esc(c.settings.checkUpdate)}</button>
        </div>
      </section>
    </div>
  </main>`
  el.addEventListener('click', async (e) => {
    const toggle = e.target.closest('[data-switch]')
    if (toggle) {
      const key = toggle.dataset.switch
      s[key] = !s[key]
      toggle.toggleAttribute('data-checked', s[key])
      toggle.toggleAttribute('data-unchecked', !s[key])
      toggle.setAttribute('aria-checked', s[key])
      return store.save()
    }
    const sel = e.target.closest('[data-select]')
    if (sel) {
      const key = sel.dataset.select
      const items = key === 'quality' ? QUALITIES.map((q) => ({ value: q, label: q })) : SPEEDS.map((v) => ({ value: v, label: speedLabel(v) }))
      return openMenu(sel, {
        items,
        value: s[key],
        align: 'end',
        onSelect: (v) => {
          s[key] = v
          sel.firstElementChild.textContent = key === 'quality' ? v : speedLabel(v)
          store.save()
        },
      })
    }
    const clear = e.target.closest('[data-clear]')
    if (clear) {
      const what = clear.dataset.clear
      const ok = await confirmDialog({ title: what === 'history' ? c.me.clearHistoryTitle : c.settings.clearSearchesTitle, confirm: c.action.clear, danger: true })
      if (!ok) return
      store.state[what] = []
      store.save()
      return toast(c.toast.cleared)
    }
    if (e.target.closest('[data-update]')) toast(c.settings.upToDate)
  })
}

export function notFound(el) {
  el.innerHTML = `<main class="page">${empty('film', t().channel.empty, `<a class="btn" href="#/">${esc(t().nav.home)}</a>`)}</main>`
}

export { syncTabs }
