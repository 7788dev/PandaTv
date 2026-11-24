import { Component, useEffect, useId, useLayoutEffect, useRef, useState, type ErrorInfo, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { MediaItem, MediaType } from '../contract/types'
import { SCROLLED_PX } from '../contract/constants'
import { t } from '../contract/copy'
import logo from './brand/logo-mark.svg?url'
import type { WindowState } from '../shared/api'
import { extra } from '../copy.extra'
import { dataAttr, EmptyState, ErrorState, Icon, IconButton, Spinner, Tip, TooltipProvider } from './components'
import { errorText, UiProvider, useNotify, useRemote, UserProvider, useUser, useWindowControlsContainer } from './state'
import { back, go, onRouteLeave, useRoute } from './router'
import { pageMemory, pageMemoryKey } from './page-memory'
import { ChannelPage, DetailPage, HomePage, LibraryPage, mediaTypes, PersonPage, RecoveryPage, SearchPage, SettingsPage } from './pages'
import { Player } from './Player'

function WindowControls({ state }: { state: WindowState }) {
  const notify = useNotify()
  const container = useWindowControlsContainer()
  const run = (operation: () => Promise<void>) => void operation().catch(error => notify(errorText(error)))
  const controls = <div className="winctl">
    <button className="winctl__btn" aria-label={t.window.minimize} onClick={() => run(window.panda.window.minimize)}><Icon name="win-min" size="sm" /></button>
    <button className="winctl__btn" aria-label={state.maximized ? t.window.restore : t.window.maximize} onClick={() => run(window.panda.window.maximize)}><Icon name={state.maximized ? 'win-restore' : 'win-max'} size="sm" /></button>
    <button className="winctl__btn winctl__btn--close" aria-label={t.window.close} onClick={() => run(window.panda.window.close)}><Icon name="win-close" size="sm" /></button>
  </div>
  return container ? createPortal(controls, container) : controls
}

function Highlight({ title, query }: { title: string; query: string }) {
  const index = title.toLowerCase().indexOf(query.toLowerCase())
  return index < 0 ? title : <>{title.slice(0, index)}<mark>{title.slice(index, index + query.length)}</mark>{title.slice(index + query.length)}</>
}

function SearchBox({ currentQuery, routeKey }: { currentQuery: string; routeKey: string }) {
  const [value, setValue] = useState(currentQuery)
  const [open, setOpen] = useState(false)
  const [debounced, setDebounced] = useState('')
  const [active, setActive] = useState(-1)
  const [online, setOnline] = useState(navigator.onLine)
  const input = useRef<HTMLInputElement>(null)
  const root = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const { state, dispatch } = useUser()
  const notify = useNotify()
  const query = value.trim()
  const close = () => { setActive(-1); setOpen(false) }
  useEffect(() => { const timer = setTimeout(() => setDebounced(query), query ? 220 : 0); return () => clearTimeout(timer) }, [query])
  const results = useRemote(async (): Promise<{ suggestions?: MediaItem[]; titles?: string[]; hot?: string[] }> => {
    if (!open) return {}
    if (/^[a-z0-9\s]+$/i.test(debounced)) return { titles: await window.panda.data.titleHints(debounced) }
    return debounced ? { suggestions: await window.panda.data.suggest(debounced) } : { hot: await window.panda.data.hotSearches() }
  }, [open, debounced, online], false, JSON.stringify([open, debounced, online]))
  useEffect(() => { setValue(currentQuery); close(); input.current?.blur() }, [routeKey])
  useEffect(() => {
    const pointer = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) close() }
    const keyboard = (event: KeyboardEvent) => {
      if (event.defaultPrevented || document.querySelector('[role="dialog"],[role="menu"]')) return
      const typing = (event.target as HTMLElement)?.matches('input,textarea,[contenteditable=true]')
      if ((event.key.toLowerCase() === 'k' && (event.ctrlKey || event.metaKey)) || (event.key === '/' && !typing)) {
        event.preventDefault(); setOpen(true); input.current?.focus(); input.current?.select()
      }
    }
    const network = () => { setActive(-1); setOnline(navigator.onLine) }
    document.addEventListener('pointerdown', pointer)
    document.addEventListener('keydown', keyboard)
    addEventListener('online', network); addEventListener('offline', network)
    return () => { document.removeEventListener('pointerdown', pointer); document.removeEventListener('keydown', keyboard); removeEventListener('online', network); removeEventListener('offline', network) }
  }, [])
  const waiting = results.loading || debounced !== query
  const suggestions = results.data?.suggestions ?? []
  const titles = results.data?.titles ?? []
  const hot = results.data?.hot ?? []
  const empty = Boolean(query) && !waiting && !results.error && suggestions.length === 0 && titles.length === 0
  const hasPanel = !query || waiting || Boolean(results.error) || suggestions.length > 0 || titles.length > 0 || empty
  const targets = waiting || results.error ? [] : query ? titles.length > 0 ? titles.map(title => `/search?q=${encodeURIComponent(title)}`) : suggestions.map(item => `/detail/${item.id}`) : hot.map(word => `/search?q=${encodeURIComponent(word)}`)
  const choose = (index: number) => {
    if (query && suggestions[index]) void dispatch({ type: 'search:add', query: suggestions[index].title }).catch(error => notify(errorText(error)))
    if (query && titles[index]) void dispatch({ type: 'search:add', query: titles[index] }).catch(error => notify(errorText(error)))
    if (targets[index]) go(targets[index])
  }
  return <div className="search" role="search" ref={root} data-open={dataAttr(open)} onBlur={event => { if (!root.current?.contains(event.relatedTarget as Node)) close() }}>
    <label className="field" data-filled={dataAttr(value)}><Icon name="search" size="sm" className="field__icon" />
      <input className="field__input" type="search" ref={input} value={value} placeholder={extra.searchInitialsPlaceholder} aria-label={t.search.label} autoComplete="off" spellCheck={false}
        role="combobox" aria-autocomplete="list" aria-haspopup="listbox" aria-expanded={open && hasPanel} aria-controls="search-suggestions" aria-activedescendant={open && active >= 0 && active < targets.length ? `search-item-${active}` : undefined}
        onChange={event => { setActive(-1); setValue(event.target.value); setOpen(true) }} onFocus={() => setOpen(true)} onClick={() => setOpen(true)} onKeyDown={event => {
          if (event.nativeEvent.isComposing) return
          const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
          if (step) {
            if (!open) { event.preventDefault(); setOpen(true); return }
            if (!targets.length) return
            event.preventDefault()
            const next = active < 0 ? step > 0 ? 0 : targets.length - 1 : (active + step + targets.length) % targets.length
            setActive(next)
            panel.current?.querySelectorAll<HTMLElement>('.suggest__item,.hotlist__item')[next]?.scrollIntoView({ block: 'nearest' })
          } else if (event.key === 'Enter') { event.preventDefault(); if (open && targets[active]) choose(active); else if (query) go(`/search?q=${encodeURIComponent(query)}`) }
          else if (event.key === 'Escape' && open) { event.preventDefault(); close() }
        }} />
      <kbd className="kbd field__hint">Ctrl K</kbd><button className="field__clear" type="button" aria-label={t.action.clearInput} tabIndex={-1} onClick={() => { setActive(-1); setValue(''); input.current?.focus(); setOpen(true) }}><Icon name="close" size="sm" /></button>
    </label>
    <div id="search-suggestions" className="search__panel" ref={panel} role={query && !waiting && !results.error && (titles.length > 0 || suggestions.length > 0) ? 'listbox' : undefined} aria-label={query ? t.search.label : undefined} inert={!open || !hasPanel} data-open={dataAttr(open && hasPanel)} onMouseDown={event => event.preventDefault()} onPointerMove={event => { if (event.movementX || event.movementY) setActive(-1) }}>
      {query ? waiting ? <Spinner /> : results.error ? <ErrorState error={results.error} retry={results.reload} /> : titles.length > 0 ? titles.map((title, index) => <a className="suggest__item" role="option" aria-selected={active === index} id={`search-item-${index}`} key={title} href={`#/search?q=${encodeURIComponent(title)}`} data-highlighted={dataAttr(active === index)} onClick={() => { void dispatch({ type: 'search:add', query: title }).catch(error => notify(errorText(error))) }}><Icon name="search" size="sm" /><span className="suggest__text">{title}</span></a>) : suggestions.length > 0 ? suggestions.map((item, index) => <a className="suggest__item" role="option" aria-selected={active === index} id={`search-item-${index}`} key={item.id} href={`#/detail/${item.id}`} data-highlighted={dataAttr(active === index)} onClick={() => { void dispatch({ type: 'search:add', query: item.title }).catch(error => notify(errorText(error))) }}><Icon name="search" size="sm" /><span className="suggest__text"><Highlight title={item.title} query={query} /></span><span className="suggest__type">{t.nav[item.type]}</span></a>) : open ? <EmptyState icon="search-x" text={t.search.empty} /> : null : <>
        {state.searches.length > 0 && <div className="search__group"><div className="search__head"><span className="search__label">{t.search.recent}</span><button className="text-btn" onClick={() => { void dispatch({ type: 'search:clear' }).catch(error => notify(errorText(error))) }}>{t.action.clear}</button></div><div className="search__chips">{state.searches.map(word => <a className="chip chip--solid" key={word} href={`#/search?q=${encodeURIComponent(word)}`}>{word}</a>)}</div></div>}
        <div className="search__group"><div className="search__head"><span className="search__label">{t.search.hot}</span></div>{waiting ? <Spinner /> : results.error ? <ErrorState error={results.error} retry={results.reload} /> : <div className="hotlist" role="listbox" aria-label={extra.hotSearchSource}>{hot.map((word, index) => <a className="hotlist__item" role="option" aria-selected={index === active} id={`search-item-${index}`} href={`#/search?q=${encodeURIComponent(word)}`} key={word} data-highlighted={dataAttr(index === active)}><span className="hotlist__rank">{index + 1}</span><span className="hotlist__title">{word}</span></a>)}</div>}</div>
      </>}
    </div>
  </div>
}

function Topbar({ path, query, routeKey, scrolled }: { path: string; query: string; routeKey: string; scrolled: boolean }) {
  const isChannel = path === '/' || path.startsWith('/channel/')
  const nav = useRef<HTMLElement>(null)
  const indicator = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const sync = () => {
      const current = nav.current?.querySelector<HTMLElement>('[aria-current=page]')
      if (current && indicator.current) { indicator.current.style.setProperty('--x', `${current.offsetLeft}px`); indicator.current.style.setProperty('--w', `${current.offsetWidth}px`) }
    }
    const observer = new ResizeObserver(sync)
    if (nav.current) observer.observe(nav.current)
    sync(); void document.fonts.ready.then(sync)
    return () => observer.disconnect()
  }, [path])
  return <header className="topbar" data-scrolled={dataAttr(scrolled)}>
    {isChannel ? <a className="topbar__logo" href="#/" aria-label={t.nav.home}><img src={logo} alt="" /></a> : <IconButton name="arrow-left" label={t.action.back} className="topbar__back" onClick={() => back()} />}
    <nav className="nav" ref={nav}>{[{ path: '/', label: t.nav.home }, ...mediaTypes.map(type => ({ path: `/channel/${type}`, label: t.nav[type] }))].map(entry => <a className="nav__item" key={entry.path} href={`#${entry.path}`} aria-current={entry.path === path ? 'page' : undefined}>{entry.label}</a>)}<span className="nav__indicator" ref={indicator} /></nav>
    <div className="topbar__spacer" /><SearchBox currentQuery={query} routeKey={routeKey} />
    <div className="topbar__actions"><Tip label={t.nav.me}><a className="icon-btn" href="#/me" aria-label={t.nav.me} aria-current={path.startsWith('/me') ? 'page' : undefined}><Icon name="user" /></a></Tip><Tip label={t.nav.settings}><a className="icon-btn" href="#/settings" aria-label={t.nav.settings} aria-current={path === '/settings' ? 'page' : undefined}><Icon name="settings" /></a></Tip></div>
  </header>
}

function PageScroll({ children, pageKey, onScroll }: { children: ReactNode; pageKey: string; onScroll: (top: number) => void }) {
  const viewport = useRef<HTMLDivElement>(null)
  const viewportId = useId()
  const content = useRef<HTMLDivElement>(null)
  const bar = useRef<HTMLDivElement>(null)
  const thumb = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dragging = useRef<{ y: number; top: number; ratio: number } | null>(null)
  const [overflow, setOverflow] = useState(false)
  const [scrolling, setScrolling] = useState(false)
  useLayoutEffect(() => {
    const el = viewport.current
    const track = bar.current
    const handle = thumb.current
    if (!el || !track || !handle) return
    const memory = pageMemory.get(pageKey)
    const desired = memory?.top ?? 0
    const href = memory?.href
    let restored = desired === 0
    let focusRestored = !href
    const sync = () => {
      const delta = el.scrollHeight - el.clientHeight
      setOverflow(delta > 0)
      if (!restored && delta >= desired) { el.scrollTop = desired; restored = true }
      if (restored && !focusRestored && href) {
        const target = el.querySelector<HTMLElement>(`a[href="${CSS.escape(href)}"]`)
        if (target) { target.focus({ preventScroll: true }); focusRestored = true }
      }
      const height = Math.max(40, track.clientHeight * el.clientHeight / Math.max(1, el.scrollHeight))
      handle.style.setProperty('--scroll-area-thumb-height', `${height}px`)
      handle.style.translate = `0 ${delta > 0 ? (track.clientHeight - height) * el.scrollTop / delta : 0}px`
      track.setAttribute('aria-valuemax', String(Math.max(0, delta)))
      track.setAttribute('aria-valuenow', String(el.scrollTop))
      onScroll(el.scrollTop)
    }
    const observedScroll = () => { if (restored) pageMemory.saveScroll(pageKey, el.scrollTop); sync(); setScrolling(true); if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => setScrolling(false), 500) }
    const touched = () => { restored = true; focusRestored = true }
    const leave = onRouteLeave(() => {
      const focused = el.contains(document.activeElement) ? document.activeElement?.closest('a[href]') : null
      if (restored) pageMemory.savePosition(pageKey, el.scrollTop, focused?.getAttribute('href') ?? undefined)
    })
    const observer = new ResizeObserver(sync)
    observer.observe(el)
    if (content.current) observer.observe(content.current)
    el.scrollTop = desired
    sync()
    el.addEventListener('scroll', observedScroll, { passive: true }); el.addEventListener('wheel', touched, { passive: true })
    el.addEventListener('pointerdown', touched, { passive: true }); el.addEventListener('keydown', touched)
    return () => { leave(); observer.disconnect(); el.removeEventListener('scroll', observedScroll); el.removeEventListener('wheel', touched); el.removeEventListener('pointerdown', touched); el.removeEventListener('keydown', touched); if (timer.current) clearTimeout(timer.current) }
  }, [pageKey])
  return <div className="scroll scroll--page"><div className="scroll__viewport" ref={viewport} id={viewportId} tabIndex={0} role="region" aria-label={extra.pageScroll}><div ref={content}>{children}</div></div>
    <div className="scroll__bar" ref={bar} hidden={!overflow} role="scrollbar" aria-orientation="vertical" aria-label={extra.pageScroll} aria-controls={viewportId} aria-valuemin={0} aria-valuemax={0} aria-valuenow={0} tabIndex={0} data-scrolling={dataAttr(scrolling)} onKeyDown={event => {
      const el = viewport.current
      if (!el) return
      const page = el.clientHeight * 0.9
      const step = event.key === 'ArrowDown' ? 40 : event.key === 'ArrowUp' ? -40 : event.key === 'PageDown' ? page : event.key === 'PageUp' ? -page : event.key === 'Home' ? -el.scrollTop : event.key === 'End' ? el.scrollHeight : undefined
      if (step === undefined) return
      event.preventDefault()
      el.scrollBy({ top: step, behavior: 'auto' })
    }} onPointerDown={event => {
      if (event.target !== event.currentTarget || !thumb.current || !viewport.current) return
      viewport.current.scrollBy({ top: (event.clientY < thumb.current.getBoundingClientRect().top ? -1 : 1) * viewport.current.clientHeight * 0.9, behavior: 'smooth' })
    }}><div className="scroll__thumb" ref={thumb} onPointerDown={event => {
      const el = viewport.current
      if (!el || !bar.current || !thumb.current) return
      event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId)
      dragging.current = { y: event.clientY, top: el.scrollTop, ratio: (el.scrollHeight - el.clientHeight) / Math.max(1, bar.current.clientHeight - thumb.current.clientHeight) }
    }} onPointerMove={event => { if (dragging.current && viewport.current) viewport.current.scrollTop = dragging.current.top + (event.clientY - dragging.current.y) * dragging.current.ratio }} onPointerUp={() => { dragging.current = null }} onPointerCancel={() => { dragging.current = null }} /></div>
  </div>
}

function AppContent() {
  const route = useRoute()
  const scrollKey = pageMemoryKey(route.path, route.query)
  const user = useUser()
  const notify = useNotify()
  const [windowState, setWindowState] = useState<WindowState>({ maximized: false, fullscreen: false })
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    if (!window.panda) return
    const unsubscribe = window.panda.window.subscribe(setWindowState)
    const notices = window.panda.app.subscribe(value => notify(value.message))
    const offline = () => notify(t.state.offline)
    addEventListener('offline', offline)
    void window.panda.window.getState().then(setWindowState).catch(error => notify(errorText(error)))
    return () => { unsubscribe(); notices(); removeEventListener('offline', offline) }
  }, [])
  const playing = route.path.match(/^\/play\/([^/]+)(?:\/(\d+))?$/)
  let page: ReactNode
  if (user.error) page = <RecoveryPage error={user.error} />
  else if (!user.ready) page = <main className="page"><Spinner /></main>
  else if (playing) page = <Player key={playing[1]} id={playing[1]} episode={Number(playing[2]) || 0} />
  else if (route.path === '/') page = <HomePage />
  else if (route.path.startsWith('/channel/') && mediaTypes.includes(route.path.slice(9) as MediaType)) page = <ChannelPage key={route.path} type={route.path.slice(9) as MediaType} params={route.query} />
  else if (/^\/detail\/[^/]+$/.test(route.path)) page = <DetailPage id={route.path.slice(8)} key={route.path} />
  else if (/^\/person\/\d+$/.test(route.path)) page = <PersonPage id={route.path.slice(8)} key={route.path} />
  else if (route.path === '/search') page = <SearchPage query={route.query.get('q')?.trim() ?? ''} />
  else if (['/me', '/me/favorites', '/me/history'].includes(route.path)) page = <LibraryPage historyTab={route.path === '/me/history'} />
  else if (route.path === '/settings') page = <SettingsPage />
  else page = <main className="page"><EmptyState text={extra.pageNotFound}><a className="btn" href="#/">{t.nav.home}</a></EmptyState></main>
  return <div className="app" data-fullscreen={dataAttr(windowState.fullscreen)}>
    {!playing && <Topbar path={route.path} query={route.path === '/search' ? route.query.get('q') ?? '' : ''} routeKey={route.key} scrolled={scrolled} />}
    {playing && user.ready && !user.error ? page : <PageScroll pageKey={scrollKey} onScroll={top => setScrolled(top > SCROLLED_PX)}>{page}</PageScroll>}
    <WindowControls state={windowState} />
  </div>
}

class AppErrorBoundary extends Component<{ children: ReactNode }, { error: unknown }> {
  state = { error: null as unknown }
  static getDerivedStateFromError(error: unknown) { return { error } }
  componentDidCatch(_error: unknown, _info: ErrorInfo) { /* The user gets a recoverable error surface, not diagnostic internals. */ }
  render() {
    if (this.state.error) return <main className="page"><ErrorState error={this.state.error} retry={() => location.reload()} /></main>
    return this.props.children
  }
}

export function App() {
  return <AppErrorBoundary><UiProvider><TooltipProvider><UserProvider><AppContent /></UserProvider></TooltipProvider></UiProvider></AppErrorBoundary>
}
