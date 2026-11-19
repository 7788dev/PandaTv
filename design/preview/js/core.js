// 原型的基础设施：数据、文案、本地状态、模板小工具。
// 注意：这个原型只是「设计稿」，用原生 JS 写成，结构和类名与手册完全一致；
// 正式应用用 React 实现，不要把这里的代码搬过去，只照抄结构和类名。

export const $ = (sel, root = document) => root.querySelector(sel)
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)]

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

/** 把文案模板里的 {变量} 换成值 */
export const fmt = (tpl, vars = {}) => tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '')

export const icon = (name, size = '', cls = '') =>
  `<svg class="icon${size ? ` icon--${size}` : ''}${cls ? ` ${cls}` : ''}" aria-hidden="true"><use href="/icons/sprite.svg#${name}"/></svg>`

export const img = (src, cls = '', extra = '') =>
  src ? `<img class="img ${cls}" src="/${esc(src)}" alt="" loading="lazy" decoding="async" ${extra}>` : ''

/** 提示：aria-label + 悬停提示（可带快捷键） */
export const tip = (label, kbd = '') => `aria-label="${esc(label)}" data-tip="${esc(label)}"${kbd ? ` data-kbd="${esc(kbd)}"` : ''}`

// ───────────────────────── 数据 ─────────────────────────
export const data = { catalog: null, copy: null, byId: new Map() }

export async function loadData() {
  const [catalog, copy] = await Promise.all([fetch('/mock/catalog.json').then((r) => r.json()), fetch('/copy/zh-CN.json').then((r) => r.json())])
  data.catalog = catalog
  data.copy = copy
  for (const it of catalog.items) data.byId.set(it.id, it)
}

export const item = (id) => data.byId.get(id)
export const t = () => data.copy

// ───────────────────────── 本地状态（收藏 / 历史 / 搜索 / 设置） ─────────────────────────
const KEY = 'panda-preview-v1'
const listeners = new Set()

function seed() {
  const u = data.catalog.user
  const day = 86400000
  return {
    favorites: [...u.favorites],
    history: u.history.map((h) => ({ ...h, at: Date.now() - h.daysAgo * day })),
    searches: [...u.searches],
    settings: { autoNext: true, skipIntro: true, quality: '1080P', speed: 1, volume: 0.8, muted: false },
  }
}

export const store = {
  state: null,
  init() {
    try {
      this.state = JSON.parse(localStorage.getItem(KEY)) || seed()
    } catch {
      this.state = seed()
    }
  },
  save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.state))
    } catch {
      /* 预览环境可能禁用存储，忽略 */
    }
    listeners.forEach((fn) => fn(this.state))
  },
  reset() {
    this.state = seed()
    this.save()
  },
  subscribe(fn) {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },
  isFavorite(id) {
    return this.state.favorites.includes(id)
  },
  toggleFavorite(id) {
    const f = this.state.favorites
    const i = f.indexOf(id)
    if (i >= 0) f.splice(i, 1)
    else f.unshift(id)
    this.save()
    return i < 0
  },
  historyOf(id) {
    return this.state.history.find((h) => h.id === id)
  },
  record(id, episode, position, duration) {
    const h = this.state.history
    const i = h.findIndex((x) => x.id === id)
    if (i >= 0) h.splice(i, 1)
    h.unshift({ id, episode, position, duration, at: Date.now() })
    this.save()
  },
  removeHistory(id) {
    this.state.history = this.state.history.filter((h) => h.id !== id)
    this.save()
  },
  addSearch(q) {
    const s = this.state.searches.filter((x) => x !== q)
    s.unshift(q)
    this.state.searches = s.slice(0, 8)
    this.save()
  },
}

// ───────────────────────── 导航 ─────────────────────────
export const nav = {
  /** 替换当前这条历史记录（播放页里切换选集用它：按返回不会在各集之间来回） */
  replace(href) {
    history.replaceState(history.state, '', href)
    dispatchEvent(new Event('hashchange'))
  },
  /** 返回上一页；没有上一页（直接打开了这个地址）就去 fallback */
  back(fallback = '#/') {
    if ((history.state?.idx ?? 0) > 0) return history.back()
    history.replaceState({ idx: 0 }, '', fallback)
    dispatchEvent(new Event('hashchange'))
  },
}

// ───────────────────────── 展示用的小计算 ─────────────────────────
/** 多集内容（剧集、综艺、动漫…）：数据里有 episodes。没有就是单片（电影） */
export const isSeries = (it) => Boolean(it.episodes)

/** 看完的标准：进度超过 95% */
export const isFinished = (h) => h.position / h.duration > 0.95

/** 「继续观看」栏目的内容：历史里还没看完的 */
export const continuing = () => store.state.history.filter((h) => !isFinished(h))

/** 卡片 / 详情页的状态文字：多集内容用数据里的 status，单片用片长 */
export const statusText = (it) => it.status || (it.runtime ? fmt(t().status.minutes, { n: it.runtime }) : '')

export const episodeLabel = (it, n) => fmt(t().status.episode, { n, unit: it.unit || '集' })

/** 「继续观看」副标题：第12集 · 剩余18分钟 */
export function progressText(it, h) {
  const left = Math.max(1, Math.round((h.duration - h.position) / 60))
  const rest = isFinished(h) ? t().status.finished : fmt(t().status.remaining, { n: left })
  return isSeries(it) ? `${episodeLabel(it, h.episode)} · ${rest}` : rest
}

export const clock = (sec) => {
  if (!Number.isFinite(sec) || sec < 0) sec = 0
  const s = Math.floor(sec % 60)
  const m = Math.floor(sec / 60) % 60
  const h = Math.floor(sec / 3600)
  const pad = (n) => String(n).padStart(2, '0')
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

export const channelTitle = (type) => t().nav[type] ?? ''

/** 倍速的写法：1.0× / 1.25× / 2.0× */
export const speedLabel = (v) => fmt(t().player.times, { n: Number.isInteger(v) ? v.toFixed(1) : String(v) })

export const SPEEDS = [0.75, 1, 1.25, 1.5, 2]
export const QUALITIES = ['4K', '1080P', '720P', '480P']
