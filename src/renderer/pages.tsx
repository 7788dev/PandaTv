import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Switch } from '@base-ui/react/switch'
import type { ChannelFilters, ChannelQuery, ChannelSort, HistoryEntry, HomeFeed, MediaItem, MediaType, Page, Settings } from '../../design/contract/types'
import { QUALITIES, SPEEDS } from '../../design/contract/constants'
import { avatarText, continuing, episodeRanges, groupHistory, playLabel, rangeOf, rankSub, speedLabel } from '../../design/contract/rules'
import { fmt, t } from '../../design/contract/copy'
import logo from '../../design/brand/logo-mark.svg?url'
import type { Detail } from '../shared/api'
import { extra } from '../copy.extra'
import { Cast, ContinueCard, dataAttr, EmptyState, EpisodeCells, ErrorState, FavoriteButton, Icon, MediaCard, MediaImage, MetaRow, PosterBox, SelectMenu, Shelf, SkeletonCard, SkeletonGrid, Spinner, Tabs } from './components'
import { errorText, useConfirm, useNotify, useRemote, useUser } from './state'
import { go } from './router'
import { wantedQuality } from './Player'

/** How long a detail page is looked at before its episode is prepared. */
const DWELL_MS = 1200

export const mediaTypes: MediaType[] = ['tv', 'movie', 'variety', 'anime', 'doc']

function Hero({ items }: { items: MediaItem[] }) {
  const [index, setIndex] = useState(0)
  const [paused, setPaused] = useState(false)
  const root = useRef<HTMLElement>(null)
  useEffect(() => setIndex(0), [items])
  const item = items[index] ?? items[0]
  if (!item) return null
  return <section className="hero" ref={root} data-paused={dataAttr(paused)} onPointerEnter={() => setPaused(true)} onPointerLeave={() => { if (!root.current?.contains(document.activeElement)) setPaused(false) }}
    onFocus={event => { if (event.target.matches(':focus-visible')) setPaused(true) }} onBlur={() => { if (!root.current?.matches(':hover')) setPaused(false) }}>
    {items.map((entry, i) => <div className="hero__slide" key={entry.id} data-active={dataAttr(index === i)}><MediaImage src={entry.backdrop ?? entry.poster} className="hero__img" eager ambient={!entry.backdrop} /></div>)}
    <div className="hero__shade" />
    <div className="hero__body" key={item.id}>
      {item.kicker && <div className="hero__kicker">{item.kicker}</div>}<h1 className="hero__title">{item.title}</h1><MetaRow item={item} className="hero__meta" />
      {(item.tagline || item.synopsis) && <p className="hero__tagline">{item.tagline || item.synopsis}</p>}
      <div className="hero__actions"><a className="btn btn--primary btn--lg" href={`#/play/${item.id}`}><Icon name="play" />{t.action.play}</a><a className="btn btn--glass btn--lg" href={`#/detail/${item.id}`}>{t.action.detail}</a></div>
    </div>
    {items.length > 1 && <div className="hero__pager">{items.map((entry, i) => <button className="hero__thumb" key={entry.id} aria-label={entry.title} data-active={dataAttr(index === i)} onClick={() => setIndex(i)}>
      <MediaImage src={entry.backdrop ?? entry.poster} eager /><i className="hero__timer" onAnimationEnd={event => { if (event.animationName === 'hero-timer') setIndex(value => (value + 1) % items.length) }} />
    </button>)}</div>}
  </section>
}

function ContinueShelf({ history }: { history: HistoryEntry[] }) {
  const ids = history.map(entry => entry.id).join(',')
  const result = useRemote(() => window.panda.data.byIds(history.map(entry => entry.id)), [ids])
  if (!history.length) return null
  if (result.error) return <section className="section"><ErrorState error={result.error} retry={result.reload} /></section>
  if (result.loading) return <Shelf title={t.home.continue} wide more="/me/history">{Array.from({ length: 5 }, (_, i) => <SkeletonCard key={i} wide />)}</Shelf>
  const byId = new Map(result.data?.map(item => [item.id, item]))
  const entries = history.filter(entry => byId.has(entry.id))
  if (!entries.length) return null
  return <Shelf title={t.home.continue} wide more="/me/history">{entries.map(entry => <ContinueCard item={byId.get(entry.id)!} history={entry} key={entry.id} />)}</Shelf>
}

export function HomePage() {
  const result = useRemote(() => window.panda.data.home(), [])
  // `home()` answers with what it has: the feed of the last read, or the top of a first read.
  // The feed read behind it, and the shelves that follow, arrive here.
  const [newer, setNewer] = useState<HomeFeed>()
  useEffect(() => window.panda.data.onHome(setNewer), [])
  const { state } = useUser()
  // The featured titles keep their place (and the slide being shown) while shelves arrive below.
  const feed = newer ?? result.data
  const heroKey = feed?.hero.map(item => `${item.id}|${item.backdrop ?? item.poster}`).join(',')
  const hero = useMemo(() => feed?.hero ?? [], [heroKey])
  if (result.error) return <main className="page"><ErrorState error={result.error} retry={result.reload} /></main>
  if (!result.data) return <main className="page page--bleed" aria-busy="true"><div className="hero skel" /><section className="section"><SkeletonGrid count={7} /></section></main>
  const data = newer ?? result.data
  if (!data.hero.length && !data.shelves.length) return <main className="page"><EmptyState text={t.channel.empty} /></main>
  return <main className={`page${data.hero.length ? ' page--bleed' : ''}`}>
    <Hero items={hero} />
    {data.shelves.map(shelf => {
      if (shelf.kind === 'continue') return <ContinueShelf key={shelf.id} history={continuing(state.history)} />
      if (shelf.kind === 'rank') return <section className="section rank" key={shelf.id}>{shelf.boards.map(board => <div className="rank__col" key={board.title}><h2 className="rank__title">{board.title}</h2><ol className="rank__list">{board.items.map((item, i) => <li key={item.id}><a className="rank__item" href={`#/detail/${item.id}`}><span className="rank__num">{i + 1}</span><PosterBox item={item} className="rank__thumb" fallback={false} /><span className="rank__text"><span className="rank__name" title={item.title}>{item.title}</span>{rankSub(item) && <span className="rank__sub" title={rankSub(item) ?? undefined}>{rankSub(item)}</span>}</span>{Boolean(item.score) && <span className="rank__score">{item.score!.toFixed(1)}</span>}</a></li>)}</ol></div>)}</section>
      return shelf.items.length > 0 && <Shelf key={shelf.id} title={shelf.title} more={shelf.more} wide={shelf.kind === 'wide'}>{shelf.items.map(item => <MediaCard item={item} wide={shelf.kind === 'wide'} key={item.id} />)}</Shelf>
    })}
  </main>
}

function FilterRow({ name, values, selected, onChange }: { name: 'genre' | 'region' | 'year'; values: string[]; selected?: string; onChange: (value: string) => void }) {
  const [expanded, setExpanded] = useState(false)
  const shown = expanded ? values : values.slice(0, name === 'region' ? 9 : 12)
  const visible = selected && !shown.includes(selected) ? [...shown, selected] : shown
  return <div className="filters__row" role="group" aria-label={t.channel[name]}>
    <span className="filters__label">{t.channel[name]}</span><div className="filters__chips">
      {['', ...visible].map(value => <button className="chip" key={value} aria-pressed={(selected || '') === value} onClick={() => onChange(value)}>{value || t.channel.all}</button>)}
      {values.length > (name === 'region' ? 9 : 12) && <button className="text-btn filters__expand" aria-expanded={expanded} aria-label={t.channel[name] + ' ' + (expanded ? t.action.collapse : t.action.expand)} onClick={() => setExpanded(value => !value)}>{expanded ? t.action.collapse : t.action.expand}<Icon name={expanded ? 'chevron-up' : 'chevron-down'} size="sm" /></button>}
    </div>
  </div>
}
function FilterRows({ filters, query, onChange }: { filters: ChannelFilters; query: ChannelQuery; onChange: (patch: Partial<ChannelQuery>) => void }) {
  return <div className="filters">
    <FilterRow name="genre" values={filters.genres} selected={query.genre} onChange={genre => onChange({ genre })} />
    {filters.regions.length > 1 && <FilterRow name="region" values={filters.regions} selected={query.region} onChange={region => onChange({ region })} />}
    <FilterRow name="year" values={filters.years} selected={query.year} onChange={year => onChange({ year })} />
  </div>
}

/** A poster grid that asks for its next page as the end of the list comes into view. */
function PagedGrid({ load, empty }: { load: (cursor?: string) => Promise<Page<MediaItem>>; empty?: ReactNode }) {
  const result = useRemote(() => load(), [load])
  const [extraPages, setExtraPages] = useState<Page<MediaItem>[]>([])
  const [moreLoading, setMoreLoading] = useState(false)
  const [moreError, setMoreError] = useState<unknown>(null)
  const sentinel = useRef<HTMLDivElement>(null)
  const epoch = useRef(0)
  const busy = useRef(false)
  useEffect(() => {
    epoch.current += 1; busy.current = false; setExtraPages([]); setMoreError(null); setMoreLoading(false)
  }, [load, result.data])
  const next = extraPages.length ? extraPages[extraPages.length - 1].next : result.data?.next
  const loadMore = useCallback(async () => {
    if (!next || busy.current || result.loading) return
    const at = epoch.current
    busy.current = true; setMoreLoading(true); setMoreError(null)
    try {
      const page = await load(next)
      if (at === epoch.current) setExtraPages(pages => [...pages, page])
    } catch (error) { if (at === epoch.current) setMoreError(error) }
    finally { if (at === epoch.current) { busy.current = false; setMoreLoading(false) } }
  }, [next, load, result.loading])
  useEffect(() => {
    if (!next || moreError || moreLoading || !sentinel.current) return
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) void loadMore() }, { rootMargin: '300px' })
    observer.observe(sentinel.current)
    return () => observer.disconnect()
  }, [next, moreError, moreLoading, loadMore])
  if (result.loading) return <SkeletonGrid />
  if (result.error) return <ErrorState error={result.error} retry={result.reload} />
  const seen = new Set<string>()
  const items = [...(result.data?.items ?? []), ...extraPages.flatMap(page => page.items)].filter(item => { if (seen.has(item.id)) return false; seen.add(item.id); return true })
  if (!items.length && !next) return <EmptyState text={t.channel.empty}>{empty}</EmptyState>
  return <div className="fade-in"><div className="grid grid--poster">{items.map(item => <MediaCard item={item} key={item.id} />)}</div>
    {moreError ? <ErrorState error={moreError} retry={() => void loadMore()} /> : next ? <div ref={sentinel}><Spinner /></div> : <p className="list-end">{t.channel.end}</p>}
  </div>
}

function ChannelResults({ type, query }: { type: MediaType; query: ChannelQuery }) {
  const queryKey = JSON.stringify(query)
  const load = useCallback((cursor?: string) => window.panda.data.channel(type, query, cursor), [type, queryKey])
  return <PagedGrid load={load} empty={<button className="btn" onClick={() => go(`/channel/${type}`, { replace: true })}>{t.action.clearFilters}</button>} />
}

export function ChannelPage({ type, params }: { type: MediaType; params: URLSearchParams }) {
  const result = useRemote(() => window.panda.data.filters(type), [type])
  const sort = params.get('sort')
  const query: ChannelQuery = { sort: sort === 'new' || sort === 'score' ? sort : 'hot', genre: params.get('genre') || undefined, region: params.get('region') || undefined, year: params.get('year') || undefined }
  const change = (patch: Partial<ChannelQuery>) => {
    const qs = new URLSearchParams(Object.entries({ ...query, ...patch }).filter(([key, value]) => Boolean(value) && !(key === 'sort' && value === 'hot')) as [string, string][])
    go(`/channel/${type}${qs.size ? `?${qs}` : ''}`, { replace: true })
  }
  return <main className="page"><header className="page__head"><h1 className="page__title">{t.nav[type]}</h1><div className="page__tools"><Tabs variant="plain" value={query.sort} items={[{ value: 'hot', label: t.channel.sortHot }, { value: 'new', label: t.channel.sortNew }, { value: 'score', label: t.channel.sortScore }]} onChange={value => change({ sort: value as ChannelSort })} /></div></header>
    {result.error ? <ErrorState error={result.error} retry={result.reload} /> : result.data ? <><FilterRows filters={result.data} query={query} onChange={change} /><ChannelResults type={type} query={query} /></> : <SkeletonGrid />}
  </main>
}

function Synopsis({ text }: { text: string }) {
  const ref = useRef<HTMLParagraphElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [overflow, setOverflow] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const check = () => { if (!expanded) setOverflow(el.scrollHeight > el.clientHeight + 2) }
    const observer = new ResizeObserver(check)
    observer.observe(el)
    void document.fonts.ready.then(check)
    check()
    return () => observer.disconnect()
  }, [text, expanded])
  return <><p className="detail__synopsis" ref={ref} data-clamped={dataAttr(!expanded)}>{text}</p>{overflow && <button className="text-btn detail__more" onClick={() => setExpanded(value => !value)}>{expanded ? t.action.collapse : t.action.expand}</button>}</>
}

function EpisodeSection({ item, current }: { item: MediaItem; current?: number }) {
  const ranges = episodeRanges(item.episodes ?? 0)
  const initial = rangeOf(ranges, current)
  const [selected, setSelected] = useState(initial?.label)
  const range = ranges.find(value => value.label === selected) ?? initial
  if (!range) return null
  return <section className="section"><header className="section__head"><h2 className="section__title">{t.detail.episodes}</h2>{ranges.length > 1 && <Tabs variant="plain" value={range.label} items={ranges.map(entry => ({ value: entry.label, label: entry.label }))} onChange={setSelected} />}</header><div className="section__body"><div className={`${item.episodeTitles?.length ? 'eplist eplist--cols' : 'eps'} fade-in`} key={range.label}><EpisodeCells item={item} current={current} from={range.from} to={range.to} /></div></div></section>
}

export function DetailPage({ id }: { id: string }) {
  const result = useRemote(() => window.panda.data.detail(id), [id])
  const related = useRemote(() => window.panda.data.related(id), [id])
  const availability = useRemote(() => window.panda.data.availability(id), [id])
  const { state } = useUser()
  // Someone who stays on the page is likely to press play: the source for the episode they
  // would get is chosen meanwhile, so the picture comes at once. A failure here is not theirs to see.
  useEffect(() => {
    if (!availability.data) return
    const episode = state.history.find(entry => entry.id === id)?.episode ?? 1
    const timer = setTimeout(() => void window.panda.data.playback(id, episode, wantedQuality(state.settings)).catch(() => {}), DWELL_MS)
    return () => clearTimeout(timer)
  }, [id, availability.data])
  if (result.error) return <main className="page"><ErrorState error={result.error} retry={result.reload} /></main>
  if (!result.data) return <main className="page"><SkeletonGrid count={7} /></main>
  const item: Detail = { ...result.data, episodes: availability.data?.episodes, episodeTitles: availability.data?.episodeTitles }
  const history = state.history.find(entry => entry.id === id)
  return <main className="page page--bleed">
    <div className="detail__backdrop"><MediaImage src={item.backdrop ?? item.poster} className="detail__bg" eager ambient={!item.backdrop} /><div className="detail__shade" /></div>
    <div className="detail__head"><PosterBox item={item} className="detail__poster" /><div className="detail__info"><h1 className="detail__title">{item.title}</h1>
      {item.originalTitle && item.originalTitle !== item.title && <div className="detail__orig">{item.originalTitle}</div>}<MetaRow item={item} className="detail__meta" region max={3} />
      <div className="detail__actions"><a className="btn btn--primary btn--lg" href={`#/play/${id}${history ? `/${history.episode}` : ''}`}><Icon name="play" />{playLabel(item, history)}</a><FavoriteButton id={id} /></div>
      {item.synopsis && <Synopsis text={item.synopsis} />}
      {(item.directors?.length || item.cast?.length) ? <dl className="credits">{item.directors?.length ? <div><dt>{t.detail.director}</dt><dd>{item.directors.join(' / ')}</dd></div> : null}{item.cast?.length ? <div><dt>{t.detail.starring}</dt><dd>{item.cast.map(person => person.name).join(' / ')}</dd></div> : null}</dl> : null}
    </div></div>
    {availability.loading && item.type !== 'movie' ? <section className="section"><Spinner /></section> : availability.error && item.type !== 'movie' ? <section className="section"><ErrorState error={availability.error} retry={availability.reload} /></section> : <EpisodeSection item={item} current={history?.episode} />}
    <Cast people={item.people ?? item.cast} />
    {related.error ? <section className="section"><ErrorState error={related.error} retry={related.reload} /></section> : related.data?.length ? <Shelf title={t.detail.related}>{related.data.map(entry => <MediaCard key={entry.id} item={entry} />)}</Shelf> : null}
  </main>
}

/** Everything one person worked on. Their name and the list are asked for together; the name arrives first. */
export function PersonPage({ id }: { id: string }) {
  const person = useRemote(() => window.panda.data.person(id), [id])
  const load = useCallback((cursor?: string) => window.panda.data.personWorks(id, cursor), [id])
  if (person.error) return <main className="page"><ErrorState error={person.error} retry={person.reload} /></main>
  return <main className="page"><header className="page__head page__head--person">
    <span className="cast__avatar">{person.data && <MediaImage src={person.data.photo} eager fallback={avatarText(person.data.name)} />}</span>
    <div className="page__heading"><div className="page__kicker">{extra.personWorks}</div><h1 className="page__title">{person.data?.name ?? ' '}</h1></div>
  </header><PagedGrid load={load} /></main>
}

export function SearchPage({ query }: { query: string }) {
  const result = useRemote(() => query ? window.panda.data.search(query) : Promise.resolve([]), [query])
  const [type, setType] = useState('')
  const { dispatch } = useUser()
  const notify = useNotify()
  useEffect(() => { setType(''); if (query.trim()) void dispatch({ type: 'search:add', query: query.trim() }).catch(error => notify(errorText(error))) }, [query, dispatch])
  const present = mediaTypes.filter(value => result.data?.some(item => item.type === value))
  const rows = (result.data ?? []).filter(item => !type || item.type === type)
  const best = rows[0]
  const exact = best && best.title.toLowerCase().includes(query.trim().toLowerCase())
  const cards = exact ? rows.slice(1) : rows
  return <main className="page"><header className="page__head"><div className="page__heading"><div className="page__kicker">{t.search.results}</div><h1 className="page__title">{query}</h1></div>{present.length > 1 && <div className="page__tools"><Tabs variant="plain" value={type} items={[{ value: '', label: t.search.all }, ...present.map(value => ({ value, label: t.nav[value] }))]} onChange={setType} /></div>}</header>
    {result.loading ? <SkeletonGrid /> : result.error ? <ErrorState error={result.error} retry={result.reload} /> : !rows.length ? <EmptyState icon="search-x" text={t.search.empty} /> : <div className="fade-in" key={`${query}:${type}`}>
      {exact && <div className="feature"><a className="poster feature__poster" href={`#/detail/${best.id}`} tabIndex={-1}><MediaImage src={best.poster} fallback={<span className="card__fallback">{best.title}</span>} /></a><div><h2 className="feature__title"><a href={`#/detail/${best.id}`} title={best.title}>{best.title}</a></h2><MetaRow item={best} className="feature__meta" region />{(best.synopsis || best.tagline) && <p className="feature__tagline">{best.synopsis || best.tagline}</p>}<div className="feature__actions"><a className="btn btn--primary" href={`#/play/${best.id}`}><Icon name="play" />{t.action.play}</a><a className="btn" href={`#/detail/${best.id}`}>{t.action.detail}</a></div></div></div>}
      {cards.length > 0 && <div className="grid grid--poster">{cards.map(item => <MediaCard key={item.id} item={item} />)}</div>}
    </div>}
  </main>
}

export function LibraryPage({ historyTab }: { historyTab: boolean }) {
  const { state, dispatch } = useUser()
  const confirm = useConfirm()
  const notify = useNotify()
  const ids = historyTab ? state.history.map(entry => entry.id) : state.favorites
  const result = useRemote(() => ids.length ? window.panda.data.byIds(ids) : Promise.resolve([]), [ids.join(','), historyTab])
  const byId = new Map(result.data?.map(item => [item.id, item]))
  const clear = async () => {
    if (!await confirm({ title: t.me.clearHistoryTitle, confirm: t.action.clear, danger: true })) return
    try { await dispatch({ type: 'history:clear' }); notify(t.toast.cleared) } catch (error) { notify(errorText(error)) }
  }
  return <main className="page"><header className="page__head"><Tabs variant="title" value={historyTab ? 'history' : 'favorites'} items={[{ value: 'favorites', label: t.me.favorites }, { value: 'history', label: t.me.history }]} onChange={value => go(value === 'history' ? '/me/history' : '/me', { replace: true })} /><div className="page__tools">{historyTab && state.history.length > 0 && <button className="text-btn" onClick={() => void clear()}>{t.action.clear}</button>}</div></header>
    {result.loading && ids.length > 0 ? <SkeletonGrid wide={historyTab} /> : result.error ? <ErrorState error={result.error} retry={result.reload} /> : !result.data?.length ? <EmptyState icon={historyTab ? 'history' : 'bookmark'} text={historyTab ? t.me.emptyHistory : t.me.emptyFavorites} /> : historyTab ? groupHistory(state.history.filter(entry => byId.has(entry.id))).map(group => <section className="group" key={group.label}><h2 className="group__label">{group.label}</h2><div className="grid grid--wide">{group.items.map(entry => <ContinueCard history={entry} item={byId.get(entry.id)!} key={entry.id} />)}</div></section>) : <div className="grid grid--poster">{result.data.map(item => <MediaCard item={item} key={item.id} />)}</div>}
  </main>
}

export function SettingsPage() {
  const { state, dispatch } = useUser()
  const confirm = useConfirm()
  const notify = useNotify()
  const info = useRemote(() => window.panda.app.info(), [])
  const [checking, setChecking] = useState(false)
  const change = (patch: Partial<Settings>) => void dispatch({ type: 'settings', patch }).catch(error => notify(errorText(error)))
  const clear = async (what: 'history' | 'search') => {
    if (!await confirm({ title: what === 'history' ? t.me.clearHistoryTitle : t.settings.clearSearchesTitle, confirm: t.action.clear, danger: true })) return
    try { await dispatch({ type: what === 'history' ? 'history:clear' : 'search:clear' }); notify(t.toast.cleared) } catch (error) { notify(errorText(error)) }
  }
  const check = async () => {
    setChecking(true)
    try { const result = await window.panda.app.checkUpdate(); notify(result.status === 'current' ? t.settings.upToDate : fmt(extra.updateAvailable, { v: result.version })) }
    catch (error) { notify(errorText(error)) }
    finally { setChecking(false) }
  }
  return <main className="page"><header className="page__head"><h1 className="page__title">{t.settings.title}</h1></header><div className="settings__body">
    <section className="setgroup"><h2 className="setgroup__label">{t.settings.playback}</h2>
      {(['autoNext', 'skipIntro'] as const).map(key => <div className="setrow" key={key}><span className="setrow__label">{t.settings[key]}</span><Switch.Root className="switch" checked={state.settings[key]} onCheckedChange={value => change({ [key]: value })} aria-label={t.settings[key]}><Switch.Thumb className="switch__thumb" /></Switch.Root></div>)}
      <div className="setrow"><span className="setrow__label">{t.settings.quality}</span><SelectMenu label={t.settings.quality} items={QUALITIES.map(value => ({ value, label: value }))} value={state.settings.quality} onChange={quality => change({ quality })}><span>{state.settings.quality}</span><Icon name="chevron-down" size="sm" /></SelectMenu></div>
      <div className="setrow"><span className="setrow__label">{t.settings.speed}</span><SelectMenu label={t.settings.speed} items={SPEEDS.map(value => ({ value, label: speedLabel(value) }))} value={state.settings.speed} onChange={speed => change({ speed })}><span>{speedLabel(state.settings.speed)}</span><Icon name="chevron-down" size="sm" /></SelectMenu></div>
    </section>
    <section className="setgroup"><h2 className="setgroup__label">{t.settings.data}</h2><div className="setrow"><span className="setrow__label">{t.settings.clearHistory}</span><button className="btn btn--sm" onClick={() => void clear('history')}>{t.action.clear}</button></div><div className="setrow"><span className="setrow__label">{t.settings.clearSearches}</span><button className="btn btn--sm" onClick={() => void clear('search')}>{t.action.clear}</button></div></section>
    <section className="setgroup"><h2 className="setgroup__label">{t.settings.about}</h2><div className="about"><img className="about__mark" src={logo} alt="" /><div><div className="about__name">{t.app.name}</div>{info.data && <div className="about__version">{fmt(t.app.version, { v: info.data.version })}</div>}</div><button className="btn btn--sm" disabled={checking} onClick={() => void check()}>{checking ? extra.updateChecking : t.settings.checkUpdate}</button></div>{Boolean(info.error) && <ErrorState error={info.error} retry={info.reload} />}</section>
  </div></main>
}
