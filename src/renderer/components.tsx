import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from 'react'
import { Menu } from '@base-ui/react/menu'
import { Tooltip } from '@base-ui/react/tooltip'
import type { IconName } from './icons/names'
import type { HistoryEntry, MediaItem } from '../contract/types'
import { avatarText, cardSub, episodeLabel, episodeState, metaParts, progressPercent, progressText, scoreText, statusText, wideImage } from '../contract/rules'
import { POPUP_OFFSET_PX, SHELF_EDGE_PX, TOOLTIP_DELAY_MS } from '../contract/constants'
import { t } from '../contract/copy'
import sprite from './icons/sprite.svg?url'
import type { Credit } from '../shared/api'
import { errorText, useNotify, useUser } from './state'
import { go } from './router'
import { extra } from '../copy.extra'

export const dataAttr = (on: unknown) => on ? '' : undefined

export function Icon({ name, size = '', className = '' }: { name: IconName; size?: '' | 'sm' | 'lg' | 'xl'; className?: string }) {
  return <svg className={`icon${size ? ` icon--${size}` : ''} ${className}`} aria-hidden="true"><use href={`${sprite}#${name}`} /></svg>
}

export function MediaImage({ src, className = '', eager = false, ambient = false, fallback }: {
  src?: string | null; className?: string; eager?: boolean; ambient?: boolean; fallback?: ReactNode
}) {
  const [failed, setFailed] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const ref = useRef<HTMLImageElement>(null)
  useEffect(() => { setFailed(false); setLoaded(Boolean(ref.current?.complete && ref.current?.naturalWidth)) }, [src])
  if (!src || failed) return fallback ?? null
  return <img ref={ref} className={`img ${className}`} src={src} alt="" data-loaded={dataAttr(loaded)} data-ambient={dataAttr(ambient)}
    loading={eager ? 'eager' : 'lazy'} decoding="async" onLoad={() => setLoaded(true)} onError={() => setFailed(true)} />
}

export function MetaRow({ item, region = false, max = 2, className = '' }: { item: MediaItem; region?: boolean; max?: number; className?: string }) {
  const score = scoreText(item)
  const parts = metaParts(item, { region, genres: max })
  if (!score && !parts.length) return null
  return <div className={`meta ${className}`}>{score && <span className="meta__score">{score}</span>}{parts.map((part, index) => <span key={`${index}:${part}`}>{part}</span>)}</div>
}

export function IconButton({ name, label, shortcut, onClick, className = '', size, disabled = false, side = 'bottom' }: {
  name: IconName; label: string; shortcut?: string; onClick?: () => void; className?: string; size?: 'sm' | 'lg'; disabled?: boolean; side?: 'top' | 'bottom'
}) {
  return <Tooltip.Root>
    <Tooltip.Trigger render={<button type="button" disabled={disabled} />} className={`icon-btn ${className}`} aria-label={label} onClick={onClick} disabled={disabled}><Icon name={name} size={size} /></Tooltip.Trigger>
    <Tooltip.Portal><Tooltip.Positioner className="layer-tooltip" side={side} sideOffset={POPUP_OFFSET_PX}>
      <Tooltip.Popup className="tooltip">{label}{shortcut && <kbd className="kbd">{shortcut}</kbd>}</Tooltip.Popup>
    </Tooltip.Positioner></Tooltip.Portal>
  </Tooltip.Root>
}

/** Design tooltip for a trigger that is not an icon button (links, overlay buttons). */
export function Tip({ label, shortcut, side = 'bottom', children }: { label: string; shortcut?: string; side?: 'top' | 'bottom'; children: ReactElement }) {
  return <Tooltip.Root>
    <Tooltip.Trigger render={children} />
    <Tooltip.Portal><Tooltip.Positioner className="layer-tooltip" side={side} sideOffset={POPUP_OFFSET_PX}>
      <Tooltip.Popup className="tooltip">{label}{shortcut && <kbd className="kbd">{shortcut}</kbd>}</Tooltip.Popup>
    </Tooltip.Positioner></Tooltip.Portal>
  </Tooltip.Root>
}

export function TooltipProvider({ children }: { children: ReactNode }) {
  return <Tooltip.Provider delay={TOOLTIP_DELAY_MS}>{children}</Tooltip.Provider>
}

export function EmptyState({ icon = 'film', text, children, alert = false }: { icon?: IconName; text: string; children?: ReactNode; alert?: boolean }) {
  return <div className="empty" role={alert ? 'alert' : undefined}><Icon name={icon} size="xl" /><p className="empty__text">{text}</p>{children}</div>
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  const offline = !navigator.onLine || errorText(error) === t.state.offline
  return <EmptyState icon={offline ? 'wifi-off' : 'cloud-off'} text={errorText(error)} alert>{retry && <button className="btn" onClick={retry}>{t.action.retry}</button>}</EmptyState>
}

export function SkeletonCard({ wide = false }: { wide?: boolean }) {
  return <div className={`card${wide ? ' card--wide' : ''}`} aria-hidden="true"><div className="card__media skel" /><span className="skel skel--text" /><span className="skel skel--text skel--short" /></div>
}

export function SkeletonGrid({ wide = false, count = 14 }: { wide?: boolean; count?: number }) {
  return <div className={`grid grid--${wide ? 'wide' : 'poster'}`} aria-busy="true" aria-label={extra.loading}>{Array.from({ length: count }, (_, i) => <SkeletonCard key={i} wide={wide} />)}</div>
}

export function Spinner() { return <div className="list-loading" role="status" aria-label={extra.loading}><span className="spinner spinner--sm" /></div> }

export function PosterBox({ item, className, fallback = true }: { item: MediaItem; className: string; fallback?: boolean }) {
  return <div className={`poster ${className}`}><MediaImage src={item.poster} eager fallback={fallback ? <span className="card__fallback">{item.title}</span> : null} /></div>
}

export function MediaCard({ item, wide = false }: { item: MediaItem; wide?: boolean }) {
  const status = statusText(item)
  const score = scoreText(item)
  const sub = cardSub(item)
  return <div className={`card${wide ? ' card--wide' : ''}`} data-id={item.id}>
    <a className="card__link" href={`#/detail/${item.id}`}>
      <div className="card__media">
        <MediaImage src={wide ? wideImage(item) : item.poster} className="card__img" fallback={<span className="card__fallback">{item.title}</span>} />
        {item.tag && <span className="tag">{item.tag}</span>}{status && <span className="card__status">{status}</span>}{score && <span className="card__score">{score}</span>}
      </div>
      <div className="card__title" title={item.title}>{item.title}</div>{sub && <div className="card__sub" title={sub}>{sub}</div>}
    </a>
    <div className="card__over"><a className="card__play" href={`#/play/${item.id}`} aria-label={`${t.action.play} ${item.title}`} tabIndex={-1}><Icon name="play" /></a></div>
  </div>
}

export function ContinueCard({ item, history }: { item: MediaItem; history: HistoryEntry }) {
  const { dispatch } = useUser()
  const notify = useNotify()
  const [removing, setRemoving] = useState(false)
  async function remove() {
    setRemoving(true)
    try {
      await dispatch({ type: 'history:remove', id: item.id })
      notify(t.toast.removed, { label: t.action.undo, onClick: () => { void dispatch({ type: 'history:restore', entry: history }).catch(error => notify(errorText(error))) } })
    } catch (error) { notify(errorText(error)); setRemoving(false) }
  }
  return <div className="card card--wide" data-id={item.id}>
    <a className="card__link" href={`#/play/${item.id}/${history.episode}`}>
      <div className="card__media"><MediaImage src={wideImage(item)} className="card__img" fallback={<span className="card__fallback">{item.title}</span>} />
        {history.duration > 0 && <span className="card__progress"><i style={{ '--p': `${progressPercent(history)}%` } as CSSProperties} /></span>}
      </div>
      <div className="card__title" title={item.title}>{item.title}</div>{history.duration > 0 && <div className="card__sub">{progressText(item, history)}</div>}
    </a>
    <div className="card__over"><span className="card__play card__play--center" aria-hidden="true"><Icon name="play" /></span><Tip label={t.action.remove}><button className="card__remove" aria-label={`${t.action.remove} ${item.title}`} disabled={removing} onClick={() => void remove()}><Icon name="close" size="sm" /></button></Tip></div>
  </div>
}

export function FavoriteButton({ id }: { id: string }) {
  const { state, dispatch } = useUser()
  const notify = useNotify()
  const [pending, setPending] = useState(false)
  const on = state.favorites.includes(id)
  async function change() {
    setPending(true)
    try { const next = await dispatch({ type: 'favorite', id }); notify(next.favorites.includes(id) ? t.toast.favorited : t.toast.unfavorited) }
    catch (error) { notify(errorText(error)) }
    finally { setPending(false) }
  }
  return <button className="btn btn--glass btn--lg" aria-pressed={on} data-favorited={dataAttr(on)} disabled={pending} onClick={() => void change()}><Icon name={on ? 'check' : 'plus'} /><span>{on ? t.action.favorited : t.action.favorite}</span></button>
}

export function Shelf({ title, more, wide = false, children }: { title: string; more?: string; wide?: boolean; children: ReactNode }) {
  const track = useRef<HTMLDivElement>(null)
  const [edge, setEdge] = useState({ start: true, end: false })
  useEffect(() => {
    const el = track.current
    if (!el) return
    const sync = () => {
      const start = el.scrollLeft < SHELF_EDGE_PX
      const end = el.scrollLeft + el.clientWidth > el.scrollWidth - SHELF_EDGE_PX
      setEdge(previous => previous.start === start && previous.end === end ? previous : { start, end })
    }
    const resize = new ResizeObserver(sync)
    resize.observe(el)
    el.addEventListener('scroll', sync, { passive: true })
    sync()
    return () => { resize.disconnect(); el.removeEventListener('scroll', sync) }
  }, [children])
  const page = (direction: number) => {
    const el = track.current
    if (!el) return
    const css = getComputedStyle(el)
    const step = el.clientWidth - parseFloat(css.paddingLeft) * 2 + parseFloat(css.columnGap)
    const max = Math.max(0, el.scrollWidth - el.clientWidth)
    const target = direction > 0 ? Math.min(max, el.scrollLeft + step) : Math.max(0, el.scrollLeft - step)
    el.scrollTo({ left: target })
  }
  return <section className={`section shelf${wide ? ' shelf--wide' : ''}`} data-at-start={dataAttr(edge.start)} data-at-end={dataAttr(edge.end)}>
    <header className="section__head"><h2 className="section__title">{title}</h2>{more && <a className="text-btn" href={`#${more}`}>{t.action.more}<Icon name="chevron-right" /></a>}</header>
    <div className="shelf__body"><div className="shelf__track" ref={track}>{children}</div>
      <button className="shelf__nav shelf__nav--prev" aria-label={t.action.prev} tabIndex={edge.start ? -1 : 0} onClick={() => page(-1)}><Icon name="chevron-left" /></button>
      <button className="shelf__nav shelf__nav--next" aria-label={t.action.next} tabIndex={edge.end ? -1 : 0} onClick={() => page(1)}><Icon name="chevron-right" /></button>
    </div>
  </section>
}

export function Tabs({ items, value, onChange, variant = '' }: { items: { value: string; label: string }[]; value: string; onChange: (value: string) => void; variant?: '' | 'plain' | 'title' }) {
  const el = useRef<HTMLDivElement>(null)
  const indicator = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const sync = () => {
      const active = el.current?.querySelector<HTMLElement>('[data-active]')
      if (active && indicator.current) {
        indicator.current.style.setProperty('--active-tab-left', `${active.offsetLeft}px`)
        indicator.current.style.setProperty('--active-tab-width', `${active.offsetWidth}px`)
      }
    }
    sync()
    const observer = new ResizeObserver(sync)
    if (el.current) observer.observe(el.current)
    void document.fonts.ready.then(sync)
    return () => observer.disconnect()
  }, [value, items])
  return <div ref={el} className={`tabs${variant ? ` tabs--${variant}` : ''}`} role="tablist" onKeyDown={event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const index = items.findIndex(item => item.value === value)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length
    onChange(items[next].value)
    el.current?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus()
  }}>
    {items.map(item => <button className="tabs__tab" key={item.value} role="tab" tabIndex={value === item.value ? 0 : -1} aria-selected={value === item.value} data-active={dataAttr(value === item.value)} onClick={() => onChange(item.value)}>{item.label}</button>)}
    {variant !== 'plain' && <span className="tabs__indicator" ref={indicator} />}
  </div>
}

export function SelectMenu<T extends string | number>({ items, value, onChange, children, className = 'select', label, side = 'bottom', align = 'end' }: {
  items: { value: T; label: string }[]; value: T; onChange: (value: T) => void; children: ReactNode; className?: string; label?: string; side?: 'top' | 'bottom'; align?: 'start' | 'center' | 'end'
}) {
  return <Menu.Root>
    <Menu.Trigger className={className} aria-label={label}>{children}</Menu.Trigger>
    <Menu.Portal><Menu.Positioner className="layer-popover" side={side} align={align} sideOffset={POPUP_OFFSET_PX} collisionPadding={POPUP_OFFSET_PX}>
      <Menu.Popup className="menu">
        <Menu.RadioGroup value={value} onValueChange={next => onChange(next as T)}>
          {side === 'top' && label && <Menu.GroupLabel className="menu__label">{label}</Menu.GroupLabel>}
          {items.map(item => <Menu.RadioItem closeOnClick className="menu__item" value={item.value} key={item.value}><span>{item.label}</span><Menu.RadioItemIndicator className="menu__check"><Icon name="check" size="sm" /></Menu.RadioItemIndicator></Menu.RadioItem>)}
        </Menu.RadioGroup>
      </Menu.Popup>
    </Menu.Positioner></Menu.Portal>
  </Menu.Root>
}

export function EpisodeCells({ item, current, from = 1, to = item.episodes ?? 1, replace = false }: { item: MediaItem; current?: number; from?: number; to?: number; replace?: boolean }) {
  return Array.from({ length: Math.max(0, to - from + 1) }, (_, index) => {
    const number = from + index
    const state = episodeState(number, current)
    const path = `/play/${item.id}/${number}`
    return <a className={item.episodeTitles?.length ? 'eplist__item' : 'ep'} href={`#${path}`} key={number} aria-label={episodeLabel(item, number)} aria-current={state === 'current' ? 'true' : undefined}
      data-current={dataAttr(state === 'current')} data-watched={dataAttr(state === 'watched')} onClick={event => { if (replace) { event.preventDefault(); go(path, { replace: true }) } }}>
      {item.episodeTitles?.length ? <><span className="eplist__num">{episodeLabel(item, number)}</span><span className="eplist__title">{item.episodeTitles[number - 1]}</span></> : number}
    </a>
  })
}

/** A person with an id leads to their works; without one (a title that names its cast only) they are a name. */
export function Cast({ people }: { people?: Credit[] }) {
  if (!people?.length) return null
  return <section className="section"><header className="section__head"><h2 className="section__title">{t.detail.cast}</h2></header><div className="section__body"><ul className="cast">{people.map((person, index) => {
    const key = `${index}:${person.name}`
    const body = <><span className="cast__avatar"><MediaImage src={person.photo} fallback={avatarText(person.name)} /></span><span className="cast__name" title={person.name}>{person.name}</span>{person.role && <span className="cast__role" title={person.role}>{person.role}</span>}</>
    return person.id ? <li key={key}><a className="cast__item" href={`#/person/${person.id}`}>{body}</a></li> : <li className="cast__item" key={key}>{body}</li>
  })}</ul></div></section>
}
