import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react'
import { Slider } from '@base-ui/react/slider'
import Hls from 'hls.js'
import type { MediaItem, Playback, Quality, Speed } from '../../design/contract/types'
import type { IconName } from '../../design/icons/names'
import { HISTORY_SAVE_SECONDS, OSD_MS, PLAYER_IDLE_MS, QUALITIES, SEEK_STEP_SECONDS, SPEEDS, UNMUTE_VOLUME, VOLUME_STEP } from '../../design/contract/constants'
import { clock, endPosition, episodeHeading, resumePosition, showSkipIntro, speedButtonLabel, speedLabel, startPosition, upNextSeconds, volumeIcon } from '../../design/contract/rules'
import { fmt, t } from '../../design/contract/copy'
import { extra } from '../copy.extra'
import type { PlaySources } from '../shared/api'
import { dataAttr, EpisodeCells, Icon, IconButton, SelectMenu } from './components'
import { errorText, useNotify, useRemote, useUser } from './state'
import { back, go } from './router'
import { bufferedRanges, playbackHistory, resolutionQuality } from './player-model'

const sessionPreferences: { speed?: Speed; quality?: Quality } = {}
/** The quality the player will ask for; whoever prepares an episode ahead must ask for the same. */
export const wantedQuality = (settings: { quality: Quality }) => sessionPreferences.quality ?? settings.quality
/** A source that has shown nothing this long after it was chosen is replaced. */
const START_MS = 15_000
/** A picture that stands still this long while nothing arrives is replaced the same way. */
const STALL_MS = 20_000
// A source that could not be chosen is asked for again by itself before the viewer is told:
// most such failures are a network that stumbled for a moment. Answers that asking again
// cannot change (no source carries the work or the episode) are shown at once.
const RESOLVE_TRIES = 2
const RESOLVE_AGAIN_MS = 800
const FINAL_ANSWERS: string[] = [extra.sourceUnavailable, extra.noEpisode, extra.notFound, extra.invalidInput, extra.unsupportedPlayback]
const finalAnswer = (error: unknown) => error instanceof Error && FINAL_ANSWERS.includes(error.message)
/** After this much unbroken playback an earlier failure no longer counts against the episode. */
const HEALTHY_MS = 60_000
/** The next episode is prepared when this little of the current one is left. */
const PREPARE_NEXT_SECONDS = 90
const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value))
type ClockState = { position: number; duration: number; buffered: { start: number; end: number }[] }

export function Player({ id, episode: requested }: { id: string; episode: number }) {
  const { state } = useUser()
  const historyEpisode = useRef(state.history.find(entry => entry.id === id)?.episode ?? 1)
  const item = useRemote(() => window.panda.data.detail(id), [id])
  const availability = useRemote(() => window.panda.data.availability(id), [id])
  const episode = requested || historyEpisode.current
  if (!item.data) return <div className="player" data-error={dataAttr(item.error)} data-waiting={dataAttr(!item.error)}>
    <header className="player__top"><IconButton name="arrow-left" className="icon-btn--lg" label={t.action.back} onClick={() => back('/detail/' + id)} /></header>
    <div className="player__center"><span className="spinner" /><div className="player__error empty"><Icon name="alert" size="xl" /><p className="empty__text">{errorText(item.error)}</p><button className="btn" onClick={item.reload}>{t.action.retry}</button></div></div>
  </div>
  const media: MediaItem = { ...item.data, ...availability.data, ...(item.data.type === 'variety' ? { unit: '期' as const } : {}) }
  return <PlayerMedia key={id + ':' + episode} item={media} episode={episode} />
}

function PlayerMedia({ item, episode }: { item: MediaItem; episode: number }) {
  const { state, dispatch } = useUser()
  const notify = useNotify()
  const root = useRef<HTMLDivElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  const panel = useRef<HTMLElement>(null)
  const panelButton = useRef<HTMLButtonElement>(null)
  const hls = useRef<Hls | null>(null)
  const initialHistory = useRef(state.history.find(entry => entry.id === item.id))
  const retryPosition = useRef<number | null>(null)
  const intended = useRef(0)
  const prepared = useRef(false)
  const started = useRef(false)
  const savingAt = useRef(0)
  const autoAttempts = useRef(0)
  const autoAdvanced = useRef(false)
  const mounted = useRef(true)
  const idleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const osdTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const volumeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [quality, setQuality] = useState<Quality>(sessionPreferences.quality ?? state.settings.quality)
  const [speed, setSpeed] = useState<Speed>(sessionPreferences.speed ?? state.settings.speed)
  const [volume, setVolumeState] = useState(state.settings.volume)
  const [muted, setMuted] = useState(state.settings.muted)
  const [request, setRequest] = useState<{ revision: number; retry: boolean; from?: string }>({ revision: 0, retry: false })
  const playback = useRemote(() => request.from ? window.panda.data.playbackFrom(item.id, episode, request.from, quality) : (request.retry ? window.panda.data.retryPlayback : window.panda.data.playback)(item.id, episode, quality), [item.id, episode, quality, request.revision])
  const [lines, setLines] = useState<PlaySources>()
  const [problem, setProblem] = useState<unknown>(null)
  const [resolveTries, setResolveTries] = useState(0)
  // The failure that has been asked about again; it stays on hand until the new answer is in.
  const [askedAgain, setAskedAgain] = useState<unknown>(null)
  const resolvingAgain = Boolean(playback.error) && (playback.error === askedAgain || (!finalAnswer(playback.error) && resolveTries < RESOLVE_TRIES))
  useEffect(() => { setResolveTries(0) }, [item.id, episode])
  useEffect(() => { if (playback.data) setResolveTries(0) }, [playback.data])
  useEffect(() => {
    if (!resolvingAgain || playback.error === askedAgain) return
    const failure = playback.error
    const timer = setTimeout(() => { setAskedAgain(failure); setResolveTries(value => value + 1); setRequest(value => ({ ...value, revision: value.revision + 1 })) }, RESOLVE_AGAIN_MS)
    return () => clearTimeout(timer)
  }, [resolvingAgain, playback.error, askedAgain])
  const [paused, setPaused] = useState(true)
  const [waiting, setWaiting] = useState(true)
  const [ready, setReady] = useState(false)
  const [time, setTime] = useState<ClockState>({ position: 0, duration: 0, buffered: [] })
  const [dragPosition, setDragPosition] = useState<number | null>(null)
  const [hover, setHover] = useState(0)
  const [panelOpen, setPanelOpen] = useState(false)
  const [cancelled, setCancelled] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [idle, setIdle] = useState(false)
  const [osd, setOsd] = useState<{ name: IconName; text: string } | null>(null)
  const [levels, setLevels] = useState<{ quality: Quality; index: number }[]>([])
  const [actualQuality, setActualQuality] = useState<Quality | undefined>()
  const latest = useRef({ item, settings: state.settings, panelOpen, dragPosition, problem, cancelled, volume, muted, playback: playback.data })
  latest.current = { item, settings: state.settings, panelOpen, dragPosition, problem, cancelled, volume, muted, playback: playback.data }
  const hasNext = Boolean(item.episodes && episode < item.episodes)
  const error = (resolvingAgain ? null : playback.error) || problem
  const busy = playback.loading || waiting || resolvingAgain
  const position = dragPosition ?? time.position
  const end = endPosition(playback.data ?? {}, time.duration, state.settings)
  const upNext = time.duration > 0 ? upNextSeconds(time.position, end, { hasNext, autoNext: state.settings.autoNext, cancelled }) : null
  const choices = levels.length > 1 ? QUALITIES.filter(q => levels.some(level => level.quality === q)) : playback.data?.qualities ?? []
  const level = muted ? 0 : volume

  const wake = () => {
    if (!mounted.current) return
    setIdle(false)
    clearTimeout(idleTimer.current)
    idleTimer.current = setTimeout(() => {
      const current = latest.current
      const occupied = video.current?.paused || video.current?.seeking || current.panelOpen || current.dragPosition !== null || current.problem || document.querySelector('.menu') || root.current?.querySelector('.player__top:hover, .player__bottom:hover, :focus-visible')
      if (occupied) wake()
      else setIdle(true)
    }, PLAYER_IDLE_MS)
  }
  const showOsd = (name: IconName, text: string) => {
    setOsd({ name, text }); clearTimeout(osdTimer.current)
    osdTimer.current = setTimeout(() => setOsd(null), OSD_MS)
  }
  const save = async (v = video.current) => {
    if (!v || !started.current) return
    const entry = playbackHistory(item.id, episode, v.currentTime, v.duration, Boolean(latest.current.item.episodes && episode < latest.current.item.episodes))
    if (!entry) return
    savingAt.current = Date.now()
    try { await dispatch({ type: 'history:record', entry }) }
    catch (error) { if (mounted.current) notify(errorText(error)) }
  }
  const saveVolume = async () => {
    clearTimeout(volumeTimer.current)
    try { await dispatch({ type: 'settings', patch: { volume: latest.current.volume, muted: latest.current.muted } }) }
    catch (error) { notify(errorText(error)) }
  }
  const setVolume = (next: number, show = false, mute = false) => {
    const value = clamp(next)
    latest.current.volume = value; latest.current.muted = mute
    setVolumeState(value); setMuted(mute)
    if (video.current) { video.current.volume = value; video.current.muted = mute }
    clearTimeout(volumeTimer.current)
    volumeTimer.current = setTimeout(() => void saveVolume(), 200)
    if (show) showOsd(volumeIcon(value, mute), Math.round((mute ? 0 : value) * 100) + '%')
    wake()
  }
  const mute = () => {
    const current = latest.current
    const off = !current.muted && current.volume > 0
    const value = current.volume === 0 && !off ? UNMUTE_VOLUME : current.volume
    setVolume(value, false, off)
    showOsd(volumeIcon(value, off), off ? t.player.mute : Math.round(value * 100) + '%')
  }
  const seekTo = (seconds: number) => {
    const v = video.current
    if (!v || !Number.isFinite(v.duration) || v.duration <= 0) return
    v.currentTime = clamp(seconds, 0, v.duration)
    setTime(value => ({ ...value, position: v.currentTime }))
    autoAdvanced.current = false
    wake()
  }
  const play = () => {
    const v = video.current
    if (!v || !ready || error) return
    if (v.ended) seekTo(0)
    if (v.paused) void v.play().catch(error => { if (error.name !== 'NotAllowedError' && error.name !== 'AbortError') setProblem(new Error(extra.playerRetry)) })
    else v.pause()
    wake()
  }
  const next = () => {
    if (!latest.current.item.episodes || episode >= latest.current.item.episodes || autoAdvanced.current) return
    autoAdvanced.current = true
    void save()
    go('/play/' + item.id + '/' + (episode + 1), { replace: true })
  }
  // Where the next source takes over: where this one got to, or where it was meant to start
  // when it never showed a picture.
  const keepPosition = () => {
    const v = video.current
    retryPosition.current = v && v.currentTime > 0 ? v.currentTime : intended.current || null
  }
  const retry = (automatic = false) => {
    keepPosition()
    void save()
    setProblem(null); setWaiting(true); setReady(false); setIdle(false)
    if (!automatic) { autoAttempts.current = 0; setResolveTries(0) }
    setRequest(value => ({ revision: value.revision + 1, retry: true }))
  }
  const changeLine = (key: string) => {
    if (key === lines?.current) return
    keepPosition()
    void save()
    setProblem(null); setWaiting(true); setReady(false); setIdle(false)
    autoAttempts.current = 0; setResolveTries(0)
    showOsd('refresh', extra.switchingLine)
    setRequest(value => ({ revision: value.revision + 1, retry: false, from: key }))
  }
  const changeQuality = (value: Quality) => {
    sessionPreferences.quality = value
    const match = levels.find(level => level.quality === value)
    if (hls.current && match && levels.length > 1) { hls.current.currentLevel = match.index; setActualQuality(value); return }
    keepPosition()
    setRequest(value => ({ ...value, retry: false }))
    setQuality(value)
  }
  const changeSpeed = (value: Speed) => {
    sessionPreferences.speed = value; setSpeed(value)
    if (video.current) video.current.playbackRate = value
  }
  const toggleFullscreen = () => void window.panda.window.fullscreen(!fullscreen).catch(error => notify(errorText(error)))
  const leave = () => {
    void save()
    void window.panda.window.fullscreen(false).catch(error => notify(errorText(error)))
    back('/detail/' + item.id)
  }
  const pip = async () => {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture()
      else if (video.current && ready) await video.current.requestPictureInPicture()
    } catch { notify(extra.unavailable) }
  }
  const controls = useRef({ save, saveVolume, play, seekTo, mute, next, leave, toggleFullscreen, setVolume, wake })
  controls.current = { save, saveVolume, play, seekTo, mute, next, leave, toggleFullscreen, setVolume, wake }

  useEffect(() => {
    mounted.current = true
    const removeFlush = window.panda.app.onBeforeClose(async () => { await controls.current.save(); await controls.current.saveVolume() })
    const removeWindow = window.panda.window.subscribe(value => setFullscreen(value.fullscreen))
    void window.panda.window.getState().then(value => setFullscreen(value.fullscreen))
    let lastXY = ''
    const move = (event: globalThis.PointerEvent) => {
      const xy = event.clientX + ':' + event.clientY
      if (xy !== lastXY) { lastXY = xy; controls.current.wake() }
    }
    const keyboard = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || document.querySelector('.menu')) return
      const target = event.target as HTMLElement
      const onSlider = Boolean(target.closest('.slider'))
      if (!onSlider && target.matches('input,textarea,[contenteditable=true]')) return
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key
      if (key === ' ' && target.closest('button,a')) return
      const actions = controls.current
      actions.wake()
      if (key === ' ' || key === 'k') actions.play()
      else if (onSlider && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(key)) return
      else if (key === 'ArrowLeft' || key === 'ArrowRight') {
        const forward = key === 'ArrowRight'
        actions.seekTo((video.current?.currentTime ?? 0) + (forward ? 1 : -1) * SEEK_STEP_SECONDS)
        showOsd(forward ? 'forward' : 'rewind', fmt(t.player.seconds, { n: SEEK_STEP_SECONDS }))
      } else if (key === 'ArrowUp' || key === 'ArrowDown') actions.setVolume((latest.current.muted ? 0 : latest.current.volume) + (key === 'ArrowUp' ? VOLUME_STEP : -VOLUME_STEP), true)
      else if (key === 'm') actions.mute()
      else if (key === 'f') actions.toggleFullscreen()
      else if (key === 'n') actions.next()
      else if (key === 'Escape') {
        if (latest.current.panelOpen) { setPanelOpen(false); panelButton.current?.focus() }
        else void window.panda.window.getState().then(value => value.fullscreen ? window.panda.window.fullscreen(false) : actions.leave())
      } else return
      event.preventDefault()
    }
    document.addEventListener('keydown', keyboard)
    root.current?.addEventListener('pointermove', move)
    controls.current.wake()
    return () => {
      mounted.current = false
      removeFlush(); removeWindow()
      document.removeEventListener('keydown', keyboard)
      root.current?.removeEventListener('pointermove', move)
      clearTimeout(idleTimer.current); clearTimeout(osdTimer.current); clearTimeout(volumeTimer.current)
      void controls.current.saveVolume()
      if (!location.hash.startsWith('#/play/')) void window.panda.window.fullscreen(false)
    }
  }, [])

  useEffect(() => {
    if (panelOpen) { panel.current?.querySelector<HTMLElement>('[data-current]')?.scrollIntoView({ block: 'center' }); panel.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true }) }
    wake()
  }, [panelOpen])

  useEffect(() => {
    const v = video.current
    const source = playback.data
    if (!v || !source) return
    setProblem(null); setWaiting(true); setReady(false); setPaused(true); setLevels([]); setActualQuality(source.quality)
    v.volume = latest.current.volume; v.muted = latest.current.muted; v.playbackRate = sessionPreferences.speed ?? state.settings.speed
    let active = true, recovered = false, positioned = false, sourceStarted = false, progressAt = Date.now(), playingSince = 0
    const startAt = (retryPosition.current ?? resumePosition(initialHistory.current, episode)) || startPosition(source, latest.current.settings)
    intended.current = startAt
    const alive = () => { progressAt = Date.now() }
    const listeners: Array<[string, EventListener]> = []
    const on = (name: string, listener: () => void) => { v.addEventListener(name, listener); listeners.push([name, listener]) }
    const refresh = () => {
      if (!active) return
      const duration = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0
      setTime({ position: v.currentTime || 0, duration, buffered: bufferedRanges(v.buffered, duration) })
    }
    const fail = () => {
      if (!active) return
      v.pause()
      if (autoAttempts.current < 2) { autoAttempts.current++; showOsd('refresh', extra.restoringSource); retry(true) }
      else { setProblem(new Error(extra.playerRetry)); setWaiting(false); setIdle(false) }
    }
    const advance = () => {
      const current = latest.current
      if (current.settings.autoNext && !current.cancelled) next()
      else v.pause()
      void save()
    }
    on('loadedmetadata', () => {
      if (!Number.isFinite(v.duration) || v.duration <= 0) return fail()
      setReady(true)
      if (!positioned) {
        positioned = true
        retryPosition.current = null
        // hls.js has already started there; a file is moved to it here.
        if (startAt > 0 && Math.abs(v.currentTime - startAt) > 1) v.currentTime = clamp(startAt, 0, Math.max(0, v.duration - 0.1))
      }
      refresh()
      void v.play().catch(error => { if (error.name === 'NotAllowedError') { sourceStarted = true; setPaused(true); setWaiting(false) } else if (error.name !== 'AbortError') fail() })
    })
    on('durationchange', refresh); on('progress', () => { alive(); refresh() })
    on('play', () => { setPaused(false); wake() })
    on('playing', () => { sourceStarted = true; started.current = true; playingSince ||= Date.now(); alive(); setPaused(false); setWaiting(false); refresh(); wake() })
    on('pause', () => { setPaused(true); setWaiting(false); setIdle(false); void save() })
    on('waiting', () => { if (!v.paused) setWaiting(true) })
    on('seeking', () => { alive(); setWaiting(!v.paused); refresh() })
    on('seeked', () => { setWaiting(false); refresh(); void save() })
    on('canplay', () => { setWaiting(false); refresh() })
    on('timeupdate', () => {
      refresh(); alive()
      const current = latest.current
      if (autoAttempts.current && playingSince && Date.now() - playingSince > HEALTHY_MS) autoAttempts.current = 0
      // The next episode's source is chosen before this one ends, so it starts without a wait.
      if (!prepared.current && v.duration > 0 && v.duration - v.currentTime <= PREPARE_NEXT_SECONDS && current.item.episodes && episode < current.item.episodes) {
        prepared.current = true
        void window.panda.data.playback(item.id, episode + 1, wantedQuality(current.settings)).catch(() => {})
      }
      if (!v.paused && current.settings.skipIntro && source.intro && v.currentTime >= source.intro.start && v.currentTime < source.intro.end) v.currentTime = Math.min(source.intro.end, v.duration)
      if (started.current && Date.now() - savingAt.current >= HISTORY_SAVE_SECONDS * 1000) void save()
      if (source.outro !== undefined && current.settings.skipIntro && v.currentTime >= source.outro && source.outro < v.duration) advance()
    })
    on('ended', advance)
    on('error', () => { if (!hls.current) fail() })
    if (source.format === 'hls' && Hls.isSupported()) {
      // Keep a larger forward buffer for the rotating public CDNs, while bounding the reverse
      // buffer so long viewing sessions do not retain hundreds of megabytes in the renderer.
      // Failed fragments retry briefly, then the player watchdog can move to another source.
      const instance = new Hls({
        enableWorker: true,
        maxBufferLength: 90,
        maxMaxBufferLength: 180,
        maxBufferSize: 96 * 1000 * 1000,
        maxBufferHole: 0.2,
        backBufferLength: 30,
        manifestLoadPolicy: {
          default: {
            maxTimeToFirstByteMs: 8_000,
            maxLoadTimeMs: 15_000,
            timeoutRetry: { maxNumRetry: 1, retryDelayMs: 0, maxRetryDelayMs: 0 },
            errorRetry: { maxNumRetry: 2, retryDelayMs: 500, maxRetryDelayMs: 4_000 },
          },
        },
        playlistLoadPolicy: {
          default: {
            maxTimeToFirstByteMs: 8_000,
            maxLoadTimeMs: 15_000,
            timeoutRetry: { maxNumRetry: 1, retryDelayMs: 0, maxRetryDelayMs: 0 },
            errorRetry: { maxNumRetry: 3, retryDelayMs: 500, maxRetryDelayMs: 4_000 },
          },
        },
        fragLoadPolicy: {
          default: {
            maxTimeToFirstByteMs: 10_000,
            maxLoadTimeMs: 45_000,
            timeoutRetry: { maxNumRetry: 2, retryDelayMs: 0, maxRetryDelayMs: 0 },
            errorRetry: { maxNumRetry: 3, retryDelayMs: 500, maxRetryDelayMs: 8_000 },
          },
        },
        startPosition: startAt > 0 ? startAt : -1,
      })
      hls.current = instance
      instance.on(Hls.Events.FRAG_LOADED, alive); instance.on(Hls.Events.FRAG_BUFFERED, alive)
      instance.on(Hls.Events.MANIFEST_PARSED, (_event, manifest) => {
        const actual = manifest.levels.flatMap((level, index) => { const quality = resolutionQuality(level.width, level.height); return quality ? [{ quality, index }] : [] })
        setLevels(actual)
        const preferred = actual.find(level => level.quality === (sessionPreferences.quality ?? quality))
        if (preferred) instance.currentLevel = preferred.index
      })
      instance.on(Hls.Events.LEVEL_SWITCHED, (_event, event) => {
        const level = instance.levels[event.level]
        if (level) setActualQuality(resolutionQuality(level.width, level.height))
      })
      instance.on(Hls.Events.ERROR, (_event, error) => {
        if (!error.fatal || !active) return
        if (error.type === Hls.ErrorTypes.MEDIA_ERROR && !recovered) { recovered = true; instance.recoverMediaError() }
        else fail()
      })
      instance.loadSource(source.url); instance.attachMedia(v)
    } else if (source.format === 'mp4' || v.canPlayType('application/vnd.apple.mpegurl')) v.src = source.url
    else { setProblem(new Error(extra.unsupportedPlayback)); setWaiting(false) }
    const startup = setTimeout(() => { if (active && !sourceStarted) fail() }, START_MS)
    // A source can die in the middle of an episode without ever reporting an error.
    const watchdog = setInterval(() => {
      if (!sourceStarted || v.paused || v.ended || v.readyState >= 3 || latest.current.problem) alive()
      else if (Date.now() - progressAt > STALL_MS) { alive(); fail() }
    }, 2000)
    return () => {
      active = false; clearTimeout(startup); clearInterval(watchdog)
      void save(v)
      listeners.forEach(([name, listener]) => v.removeEventListener(name, listener))
      hls.current?.destroy(); hls.current = null
      v.pause(); v.removeAttribute('src'); v.load()
    }
  }, [playback.data])

  useEffect(() => {
    if (!playback.data) return
    let active = true
    // Asked once the episode has a source, so the answer says which one that is.
    void window.panda.data.sources(item.id, episode).then(value => { if (active) setLines(value) }, () => {})
    return () => { active = false }
  }, [playback.data])

  const ratio = (event: PointerEvent<HTMLElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    return bounds.width ? clamp((event.clientX - bounds.left) / bounds.width) : 0
  }
  return <div className="player" ref={root} data-paused={dataAttr(paused)} data-waiting={dataAttr(busy && !error)} data-error={dataAttr(error)} data-idle={dataAttr(idle && !error && !busy)} onPointerDown={wake}>
    <video className="player__video" ref={video} playsInline preload="auto" poster={item.backdrop ?? undefined} onClick={() => panelOpen ? setPanelOpen(false) : play()} onDoubleClick={toggleFullscreen} />
    <div className="player__shade" />
    <header className="player__top"><IconButton name="arrow-left" className="icon-btn--lg" label={t.action.back} shortcut="Esc" onClick={leave} /><div className="player__heading"><span className="player__title">{item.title}</span>{episodeHeading(item, episode) && <span className="player__ep">{episodeHeading(item, episode)}</span>}</div></header>
    <div className="player__center"><button className="player__bigplay" aria-label={t.player.play} tabIndex={-1} onClick={play} disabled={!ready}><Icon name="play" /></button><span className="spinner" /><div className="player__error empty"><Icon name="alert" size="xl" /><p className="empty__text">{error ? errorText(error) : t.player.error}</p><button className="btn" onClick={() => retry()}>{t.action.retry}</button></div></div>
    <div className="osd" role="status" data-open={dataAttr(osd)}>{osd && <><Icon name={osd.name} /><span>{osd.text}</span></>}</div>
    <button className="btn btn--glass player__skip" data-open={dataAttr(showSkipIntro(time.position, playback.data ?? {}, state.settings) && upNext === null && !panelOpen)} onClick={() => { if (playback.data?.intro) seekTo(playback.data.intro.end) }}>{t.player.skipIntro}</button>
    <div className="upnext" data-open={dataAttr(upNext !== null && !panelOpen)}><div className="upnext__label">{upNext !== null && fmt(t.player.upNext, { n: upNext })}</div><div className="upnext__title">{episodeHeading(item, episode + 1)}</div><div className="upnext__actions"><button className="btn btn--primary btn--sm" onClick={next}>{t.player.playNow}</button><button className="btn btn--ghost btn--sm" onClick={() => setCancelled(true)}>{t.action.cancel}</button></div></div>
    <div className="player__bottom">
      <div className="seek" role="slider" tabIndex={ready ? 0 : -1} aria-label={t.player.seek} aria-disabled={!ready} aria-valuemin={0} aria-valuemax={time.duration} aria-valuenow={Math.floor(position)} aria-valuetext={clock(position)} data-dragging={dataAttr(dragPosition !== null)}
        style={{ '--p': (time.duration ? 100 * position / time.duration : 0) + '%', '--h': hover * 100 + '%' } as CSSProperties}
        onPointerDown={event => { if (!ready) return; event.currentTarget.setPointerCapture(event.pointerId); setDragPosition(ratio(event) * time.duration) }}
        onPointerMove={event => { const p = ratio(event); setHover(p); if (dragPosition !== null) setDragPosition(p * time.duration) }}
        onPointerUp={event => { if (dragPosition !== null) { seekTo(ratio(event) * time.duration); setDragPosition(null) } }}
        onPointerCancel={() => setDragPosition(null)}
        onKeyDown={event => { if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); seekTo(event.key === 'Home' ? 0 : time.duration) } }}>
        <div className="seek__track">{time.buffered.map((range, i) => <i className="seek__buffer" key={i} style={{ left: range.start / time.duration * 100 + '%', width: (range.end - range.start) / time.duration * 100 + '%' }} />)}<i className="seek__played" /></div><i className="seek__thumb" /><span className="seek__tip">{clock(hover * time.duration)}</span>
      </div>
      <div className="player__bar"><div className="player__group">
        <IconButton name={paused ? 'play' : 'pause'} className="player__play" label={paused ? t.player.play : t.player.pause} shortcut="Space" onClick={play} disabled={!ready || Boolean(error)} side="top" />
        {hasNext && <IconButton name="next" label={t.player.next} shortcut="N" onClick={next} side="top" />}
        <div className="player__volume"><IconButton name={volumeIcon(volume, muted)} label={level ? t.player.mute : t.player.unmute} shortcut="M" onClick={mute} side="top" />
          <Slider.Root className="slider" min={0} max={100} step={1} value={Math.round(level * 100)} onValueChange={value => setVolume(Number(value) / 100)} onValueCommitted={() => void saveVolume()}>
            <Slider.Control className="slider__control"><Slider.Track className="slider__track"><Slider.Indicator className="slider__range" /><Slider.Thumb className="slider__thumb" aria-label={t.player.volume} onKeyDown={event => {
              // Design steps: arrows move the volume by VOLUME_STEP; up/down also show the level.
              const direction = event.key === 'ArrowRight' || event.key === 'ArrowUp' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -1 : 0
              if (!direction || event.ctrlKey || event.metaKey || event.altKey) return
              event.preventDefault() // Base UI skips its own 1% step for prevented events
              setVolume(level + direction * VOLUME_STEP, event.key === 'ArrowUp' || event.key === 'ArrowDown')
            }} /></Slider.Track></Slider.Control>
          </Slider.Root>
        </div><div className="player__time"><time>{clock(position)}</time><span>{time.duration > 0 ? ' / ' + clock(time.duration) : ''}</span></div>
      </div><div className="player__group">
        {item.episodes && <button ref={panelButton} className="btn btn--ghost" aria-expanded={panelOpen} data-popup-open={dataAttr(panelOpen)} onClick={() => setPanelOpen(value => !value)}>{t.player.episodes}</button>}
        <SelectMenu className="btn btn--ghost" label={t.player.speed} side="top" value={speed} items={SPEEDS.map(value => ({ value, label: speedLabel(value) }))} onChange={changeSpeed}>{speedButtonLabel(speed)}</SelectMenu>
        {choices.length > 1 && <SelectMenu className="btn btn--ghost" label={t.player.quality} side="top" value={actualQuality ?? playback.data?.quality ?? quality} items={choices.map(value => ({ value, label: value }))} onChange={changeQuality}>{actualQuality ?? playback.data?.quality ?? t.player.quality}</SelectMenu>}
        {lines && lines.list.length > 1 && <SelectMenu className="btn btn--ghost" label={extra.line} side="top" value={lines.current ?? ''} items={lines.list.map(entry => ({ value: entry.key, label: entry.name }))} onChange={changeLine}>{extra.line}</SelectMenu>}
        {document.pictureInPictureEnabled && <IconButton name="pip" label={t.player.pip} onClick={() => void pip()} disabled={!ready} side="top" />}
        <IconButton name={fullscreen ? 'fullscreen-exit' : 'fullscreen'} label={fullscreen ? t.player.exitFullscreen : t.player.fullscreen} shortcut="F" onClick={toggleFullscreen} side="top" />
      </div></div>
    </div>
    {item.episodes && <aside className="player__panel" ref={panel} data-open={dataAttr(panelOpen)} aria-hidden={!panelOpen} inert={!panelOpen}>
      <div className="player__panel-head"><h2 className="player__panel-title">{t.player.episodes}</h2><button className="icon-btn" aria-label={t.action.close} onClick={() => { setPanelOpen(false); panelButton.current?.focus() }}><Icon name="close" /></button></div>
      <div className="player__panel-body"><div className={item.episodeTitles?.length ? 'eplist' : 'eps'}><EpisodeCells item={item} current={episode} replace /></div></div>
    </aside>}
  </div>
}
