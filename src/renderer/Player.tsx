import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react'
import { Dialog } from '@base-ui/react/dialog'
import { Slider } from '@base-ui/react/slider'
import Hls from 'hls.js'
import type { MediaItem, Playback, Quality, Speed } from '../contract/types'
import type { IconName } from './icons/names'
import { HISTORY_SAVE_SECONDS, OSD_MS, PLAYER_IDLE_MS, QUALITIES, SEEK_STEP_SECONDS, SPEEDS, UNMUTE_VOLUME, VOLUME_STEP } from '../contract/constants'
import { clock, endPosition, episodeHeading, episodeToPlay, nextEpisode, resumePosition, showSkipIntro, speedButtonLabel, speedLabel, startPosition, upNextSeconds, volumeIcon } from '../contract/rules'
import { fmt, t } from '../contract/copy'
import { extra } from '../copy.extra'
import type { PlaySources } from '../shared/api'
import type { PlaybackRuntimeRules } from '../shared/api'
import { evaluateSwitch } from '../shared/rules/switch-budget'
import { shouldTakeOver } from '../shared/rules/buffer'
import type { BufferSample, BufferScene, SwitchEvent } from '../shared/rules/types'
import { dataAttr, EpisodeCells, Icon, IconButton, SelectMenu } from './components'
import { errorText, useCatalogueRevision, useNotify, useRemote, useUser } from './state'
import { back, go } from './router'
import { bufferedRanges, playbackBuffer, playbackHistory, playbackProgress, qualityLevelIndex, resolutionQuality } from './player-model'
import { createFrameRateState, sampleFrameRate } from './playback-adaptation'
import { playbackPreferences as sessionPreferences } from './playback-preferences'
import { StartupWatchdog } from './startup-watchdog'
import { scorePlaybackOffsets, videoFrameSample, waitForSeek } from './playback-alignment'

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
/** The next episode is prepared when this little of the current one is left. */
const PREPARE_NEXT_SECONDS = 90
const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value))
type ClockState = { position: number; duration: number; buffered: { start: number; end: number }[] }

export default function Player({ id, episode: requested }: { id: string; episode: number }) {
  const { state } = useUser()
  const historyEpisode = useRef(Math.min(state.history.find(entry => entry.id === id)?.episode ?? 1, 10000))
  const item = useRemote(() => window.panda.data.subject(id), [id])
  const catalogueRevision = useCatalogueRevision(id)
  const availability = useRemote(() => window.panda.data.availability(id, requested ? undefined : historyEpisode.current), [id, catalogueRevision, requested], true)
  const [initial, setInitial] = useState<number>()
  useEffect(() => {
    if (!requested && initial === undefined && availability.data) setInitial(episodeToPlay(availability.data, historyEpisode.current))
  }, [requested, initial, availability.data])
  const episode = requested || initial || (availability.error ? historyEpisode.current : undefined)
  if (!item.data || !episode) return <main className="player" aria-busy="true" data-error={dataAttr(item.error)} data-waiting={dataAttr(!item.error)}>
    <header className="player__top"><IconButton name="arrow-left" className="icon-btn--lg" label={t.action.back} onClick={() => back('/detail/' + id)} /></header>
    <div className="player__center"><span className="spinner" role="status" aria-label={extra.loading} /><div className="player__error empty" role="alert"><Icon name="alert" size="xl" /><p className="empty__text">{errorText(item.error)}</p><button className="btn" onClick={item.reload}>{t.action.retry}</button></div></div>
  </main>
  const media: MediaItem = { ...item.data, ...availability.data, ...(item.data.type === 'variety' ? { unit: '期' as const } : {}) }
  return <PlayerMedia key={id + ':' + episode} item={media} episode={episode} catalogueRevision={catalogueRevision} />
}

function PlayerMedia({ item, episode, catalogueRevision }: { item: MediaItem; episode: number; catalogueRevision: number }) {
  const { state, dispatch } = useUser()

  const notify = useNotify()
  const root = useRef<HTMLDivElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  const handoff = useRef<HTMLImageElement>(null)
  const handoffPending = useRef(false)
  const bridgeActive = useRef(false)
  const fallbackRequested = useRef(false)
  const activeSource = useRef<Playback | null>(null)
  const sourceHealthy = useRef(false)
  const playRequested = useRef(true)
  const notifiedSwitchFailure = useRef<number | null>(null)
  const requestedSpeed = useRef<Speed>(sessionPreferences.speed ?? state.settings.speed)
  const activeSpeed = useRef<Speed>(sessionPreferences.activeSpeed ?? requestedSpeed.current)
  const panel = useRef<HTMLDivElement>(null)
  const panelClose = useRef<HTMLButtonElement>(null)
  const hls = useRef<Hls | null>(null)
  const initialHistory = useRef(state.history.find(entry => entry.id === item.id))
  const retryPosition = useRef<number | null>(null)
  const intended = useRef(0)
  const prepared = useRef<number | undefined>(undefined)
  const started = useRef(false)
  const savingAt = useRef(0)
  const switchEvents = useRef<SwitchEvent[]>([])
  const bufferSamples = useRef<BufferSample[]>([])
  const detachMedia = useRef<(() => void) | undefined>(undefined)
  const installed = useRef<Playback | undefined>(undefined)
  const [currentMedia, setCurrentMedia] = useState<Playback>()
  const seekRevision = useRef(0)
  const pendingSwitch = useRef<AbortController | undefined>(undefined)
  const bufferScene = useRef<BufferScene>('playing')
  const playbackRules = useRef<PlaybackRuntimeRules | undefined>(undefined)
  const autoAdvanced = useRef(false)
  const mounted = useRef(true)
  const idleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const osdTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const volumeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const handoffTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const startupWatch = useRef<StartupWatchdog | null>(null)
  const [quality, setQuality] = useState<Quality>(sessionPreferences.quality ?? state.settings.quality)
  const [speed, setSpeed] = useState<Speed>(activeSpeed.current)
  const [volume, setVolumeState] = useState(state.settings.volume)
  const [muted, setMuted] = useState(state.settings.muted)
  const [request, setRequest] = useState<{ revision: number; retry: boolean; retryFailure?: 'probe' | 'stall'; from?: string }>({ revision: 0, retry: false })
  const playback = useRemote(() => {
    if (installed.current || request.from || request.retry) return window.panda.data.prepareSwitch(item.id, episode, {
      quality, from: request.from, retry: request.retry, failure: request.retry ? request.retryFailure : undefined,
    })
    return window.panda.data.playback(item.id, episode, quality)
  }, [item.id, episode, quality, request.revision], true, request.revision)
  const [lines, setLines] = useState<PlaySources>()
  const [problem, setProblem] = useState<unknown>(null)
  const [resolveTries, setResolveTries] = useState(0)
  // The failure that has been asked about again; it stays on hand until the new answer is in.
  const [askedAgain, setAskedAgain] = useState<unknown>(null)
  const resolvingAgain = Boolean(playback.error) && (playback.error === askedAgain || (!finalAnswer(playback.error) && resolveTries < RESOLVE_TRIES))
  useEffect(() => { sessionPreferences.observeDefaults(state.settings) }, [state.settings])
  useEffect(() => {
    let active = true
    void window.panda.data.playbackRules().then(value => { if (active) playbackRules.current = value }, () => {})
    return () => { active = false }
  }, [])
  useEffect(() => { setResolveTries(0) }, [item.id, episode])
  useEffect(() => { if (playback.data) setResolveTries(0) }, [playback.data])
  useEffect(() => {
    if (!resolvingAgain || playback.error === askedAgain) return
    const failure = playback.error
    const timer = setTimeout(() => { setAskedAgain(failure); setResolveTries(value => value + 1); setRequest(value => ({ ...value, revision: value.revision + 1 })) }, RESOLVE_AGAIN_MS)
    return () => clearTimeout(timer)
  }, [resolvingAgain, playback.error, askedAgain])
  const [paused, setPaused] = useState(false)
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
  const [levels, setLevels] = useState<{ quality: Quality; index: number; bitrate: number }[]>([])
  const [actualQuality, setActualQuality] = useState<Quality | undefined>()
  const hasAlternative = (lines?.list.length ?? 0) > 1
  const latest = useRef({ item, settings: state.settings, panelOpen, dragPosition, problem, cancelled, volume, muted, hasAlternative })
  latest.current = { item, settings: state.settings, panelOpen, dragPosition, problem, cancelled, volume, muted, hasAlternative }
  const bridgingActiveLine = Boolean(bridgeActive.current && sourceHealthy.current && activeSource.current && started.current && video.current)
  const upcoming = nextEpisode(item, episode)
  const hasNext = upcoming !== undefined
  const error = (resolvingAgain || bridgingActiveLine ? null : playback.error) || problem
  const busy = (!bridgingActiveLine && playback.loading) || waiting || (resolvingAgain && !bridgingActiveLine)
  const position = dragPosition ?? time.position
  const end = endPosition(currentMedia ?? {}, time.duration, state.settings)
  const upNext = time.duration > 0 ? upNextSeconds(time.position, end, { hasNext, autoNext: state.settings.autoNext, cancelled }) : null
  const choices = levels.length > 1 ? QUALITIES.filter(q => levels.some(level => level.quality === q)) : currentMedia?.qualities ?? []
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
    const entry = playbackHistory(item.id, episode, v.currentTime, v.duration, nextEpisode(latest.current.item, episode))
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
    seekRevision.current++
    v.currentTime = clamp(seconds, 0, v.duration)
    setTime(value => ({ ...value, position: v.currentTime }))
    autoAdvanced.current = false
    wake()
  }
  const play = () => {
    const v = video.current
    if (!v || error) return
    if (!ready) {
      playRequested.current = !playRequested.current
      setPaused(!playRequested.current)
      startupWatch.current?.setEnabled(playRequested.current)
      if (!playRequested.current) v.pause()
      wake()
      return
    }
    if (v.ended) seekTo(0)
    playRequested.current = v.paused
    if (playRequested.current) void v.play().catch(error => { if (error.name !== 'NotAllowedError' && error.name !== 'AbortError') setProblem(new Error(extra.playerRetry)) })
    else v.pause()
    wake()
  }
  const next = () => {
    const target = nextEpisode(latest.current.item, episode)
    if (target === undefined || autoAdvanced.current) return
    autoAdvanced.current = true
    void save()
    go('/play/' + item.id + '/' + target, { replace: true })
  }
  // Where the next source takes over: where this one got to, or where it was meant to start
  // when it never showed a picture.
  const keepPosition = () => {
    const v = video.current
    retryPosition.current = v && v.currentTime > 0 ? v.currentTime : intended.current || null
  }
  const retry = (automatic = false, failure?: 'probe' | 'stall') => {
    if (automatic) {
      const allowed = playbackRules.current
        ? evaluateSwitch(switchEvents.current, Date.now(), playbackRules.current.budget).allowed
        : switchEvents.current.length < 2
      if (!allowed) {
        setProblem(new Error(extra.playerRetry)); setWaiting(false); setIdle(false)
        return
      }
      switchEvents.current.push({ at: Date.now(), mode: 'auto' })
      showOsd('refresh', extra.restoringSource)
    }
    pendingSwitch.current?.abort()
    keepPosition()
    void save()
    const canBridge = Boolean(sourceHealthy.current && activeSource.current && started.current && video.current && video.current.readyState >= 2)
    // A failed candidate may have no decoded frames. Keep the snapshot from the last good line.
    handoffPending.current ||= Boolean(started.current && video.current && video.current.readyState >= 2)
    bridgeActive.current = canBridge
    setProblem(null); setWaiting(!canBridge); setReady(canBridge); setIdle(false)
    if (!automatic) setResolveTries(0)
    setRequest(value => ({ revision: value.revision + 1, retry: true, retryFailure: failure, from: undefined }))
  }
  const changeLine = (key: string) => {
    if (key === lines?.current) return
    pendingSwitch.current?.abort()
    bufferSamples.current = []
    keepPosition()
    void save()
    playRequested.current = video.current?.paused !== true
    const canBridge = Boolean(sourceHealthy.current && activeSource.current && started.current && video.current && video.current.readyState >= 2)
    handoffPending.current = canBridge
    bridgeActive.current = canBridge
    fallbackRequested.current = false
    setProblem(null); setWaiting(!canBridge); setReady(canBridge); setIdle(false)
    setResolveTries(0)
    showOsd('refresh', extra.switchingLine)
    setRequest(value => ({ revision: value.revision + 1, retry: false, from: key }))
  }
  const changeQuality = (value: Quality) => {
    pendingSwitch.current?.abort()
    sessionPreferences.quality = value
    const target = qualityLevelIndex(levels, value)
    if (hls.current && target !== undefined && levels.length > 1) { hls.current.currentLevel = target; hls.current.autoLevelCapping = target; setActualQuality(value); setQuality(value); return }
    keepPosition()
    setRequest(value => ({ ...value, retry: false }))
    setQuality(value)
  }
  const changeSpeed = (value: Speed) => {
    sessionPreferences.speed = value
    sessionPreferences.activeSpeed = value
    requestedSpeed.current = value
    activeSpeed.current = value
    setSpeed(value)
    if (video.current) { video.current.defaultPlaybackRate = value; video.current.playbackRate = value }
  }
  const toggleFullscreen = () => void window.panda.window.fullscreen(!fullscreen).catch(error => notify(errorText(error)))
  const leave = () => {
    pendingSwitch.current?.abort()
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
    if (!bridgingActiveLine || !playback.error || resolvingAgain) return
    if (request.from) {
      if (!fallbackRequested.current) {
        fallbackRequested.current = true
        setResolveTries(0)
        setAskedAgain(null)
        retry(true)
      }
      return
    }
    if (notifiedSwitchFailure.current === request.revision) return
    notifiedSwitchFailure.current = request.revision
    setWaiting(false)
    setReady(true)
    notify(extra.lineSwitchFailed)
  }, [bridgingActiveLine, playback.error, resolvingAgain, request.from, request.revision, notify])

  useEffect(() => {
    mounted.current = true
    const playerRoot = root.current
    const removeFlush = window.panda.app.onBeforeClose(async () => { await controls.current.save(); await controls.current.saveVolume() })
    const removeWindow = window.panda.window.subscribe(value => setFullscreen(value.fullscreen))
    void window.panda.window.getState().then(value => setFullscreen(value.fullscreen))
    let lastXY = ''
    const move = (event: globalThis.PointerEvent) => {
      const xy = event.clientX + ':' + event.clientY
      if (xy !== lastXY) { lastXY = xy; controls.current.wake() }
    }
    const keyboard = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || latest.current.panelOpen || document.querySelector('.menu[data-open]')) return
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
      else if (key === 'Escape') void window.panda.window.getState().then(value => value.fullscreen ? window.panda.window.fullscreen(false) : actions.leave())
      else return
      event.preventDefault()
    }
    document.addEventListener('keydown', keyboard)
    playerRoot?.addEventListener('pointermove', move)
    controls.current.wake()
    return () => {
      mounted.current = false
      removeFlush(); removeWindow()
      document.removeEventListener('keydown', keyboard)
      playerRoot?.removeEventListener('pointermove', move)
      clearTimeout(idleTimer.current); clearTimeout(osdTimer.current); clearTimeout(volumeTimer.current); clearTimeout(handoffTimer.current)
      void controls.current.saveVolume()
      if (!location.hash.startsWith('#/play/')) void window.panda.window.fullscreen(false)
    }
  }, [])

  useEffect(() => {
    wake()
  }, [panelOpen])

  useEffect(() => () => {
    pendingSwitch.current?.abort()
    detachMedia.current?.()
    detachMedia.current = undefined
    installed.current = undefined
    activeSource.current = null
  }, [])

  useEffect(() => {
    const v = video.current
    const source = playback.data
    if (!v || !source || playback.loading || playback.error || source === installed.current) return
    const controller = new AbortController()
    pendingSwitch.current = controller
    const { signal } = controller
    const initialize = async () => {
      const origin = activeSource.current
      const fromKey = origin?.sourceKey
      let offset = 0
      if (origin && fromKey && source.sourceKey && fromKey !== source.sourceKey) {
        const rules = playbackRules.current ?? await window.panda.data.playbackRules()
        // A seek during frame verification invalidates the old anchor. The old media
        // stays attached and retains its clock, event handlers and playback intent.
        for (;;) {
          signal.throwIfAborted()
          if (v.seeking) await waitForSeek(v, signal)
          const revision = seekRevision.current
          const position = v.currentTime
          const startedAt = performance.now()
          const input = {
            workId: item.id, episode, position,
            from: { sourceKey: fromKey, duration: origin.duration, durationSource: origin.durationSource, fingerprint: origin.manifestFingerprint },
            to: { sourceKey: source.sourceKey, duration: source.duration, durationSource: source.durationSource, fingerprint: source.manifestFingerprint },
            capability: 'frames' as const,
            elapsedMs: 0,
          }
          let verdict = await window.panda.data.align(input)
          signal.throwIfAborted()
          if (revision !== seekRevision.current) continue
          if (verdict.candidateOffsets?.length) {
            const frame = videoFrameSample(v)
            if (!frame.valid) throw new Error('frames-unavailable')
            const samplePosition = v.currentTime
            const remaining = rules.alignment.frameBudgetMs - (performance.now() - startedAt)
            if (remaining <= 0) throw new Error('over-budget')
            const samples = await scorePlaybackOffsets(source, samplePosition, verdict.candidateOffsets.slice(0, rules.alignment.sampleLimit), frame, remaining, signal)
            signal.throwIfAborted()
            if (revision !== seekRevision.current) continue
            verdict = await window.panda.data.align({ ...input, position: samplePosition, samples, elapsedMs: performance.now() - startedAt })
          }
          signal.throwIfAborted()
          if (revision !== seekRevision.current) continue
          if (verdict.offsetSeconds === undefined || (verdict.layer !== 'offset-cache' && !verdict.verified)) throw new Error(verdict.reason ?? 'no-match')
          offset = verdict.offsetSeconds
          break
        }
      }
      signal.throwIfAborted()
      if (source.selectionId !== undefined && !await window.panda.data.acceptSwitch(item.id, episode, source.selectionId)) throw new Error(extra.lineSwitchFailed)
      signal.throwIfAborted()
      const startAt = origin ? Math.max(0, v.currentTime + offset)
        : (retryPosition.current ?? resumePosition(initialHistory.current, episode)) || startPosition(source, latest.current.settings)
      detachMedia.current?.()
      installed.current = source
      setCurrentMedia(source)
      activeSource.current = null
      started.current = false
      sourceHealthy.current = false
      setProblem(null); setWaiting(true); setReady(false); setPaused(!playRequested.current); setLevels([]); setActualQuality(source.quality)
      v.volume = latest.current.volume; v.muted = latest.current.muted
      v.defaultPlaybackRate = activeSpeed.current; v.playbackRate = activeSpeed.current
      let active = true, failed = false, recovered = false, positioned = false, sourceStarted = false, progressAt = Date.now()
      bufferScene.current = 'playing'
      let frameState = createFrameRateState()
      let lastPosition = -1
      intended.current = startAt
      let lastHealthAt = Date.now()
      let lastHealthPosition = v.currentTime
      let buffering = false
      let nextHealthFlush = Date.now() + 5000
      let healthPlaySeconds = 0
      let healthStallSeconds = 0
      bufferSamples.current = [{ at: Date.now(), ahead: 0, position: v.currentTime }]
      const alive = () => { progressAt = Date.now() }
      const listeners: Array<[string, EventListener]> = []
      const on = (name: string, listener: () => void) => { v.addEventListener(name, listener); listeners.push([name, listener]) }
      const refresh = () => {
        if (!active) return
        const duration = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0
        if (handoffPending.current && !sourceStarted) return
        setTime({ position: v.currentTime || 0, duration, buffered: bufferedRanges(v.buffered, duration) })
      }
      const fail = () => {
        if (!active || failed) return
        failed = true
        sourceHealthy.current = false
        v.pause()
        retry(true, sourceStarted ? 'stall' : 'probe')
      }
      const startup = new StartupWatchdog(START_MS, () => { if (active && !sourceStarted && playRequested.current) fail() })
      startupWatch.current = startup
      const advance = () => {
        const current = latest.current
        if (current.settings.autoNext && !current.cancelled) next()
        else v.pause()
        void save()
      }
      on('loadedmetadata', () => {
        if (!Number.isFinite(v.duration) || v.duration <= 0) return fail()
        v.defaultPlaybackRate = activeSpeed.current; v.playbackRate = activeSpeed.current
        setSpeed(activeSpeed.current)
        setReady(true)
        if (!positioned) {
          positioned = true
          retryPosition.current = null
          // hls.js has already started there; a file is moved to it here.
          if (startAt > 0 && Math.abs(v.currentTime - startAt) > 1) v.currentTime = clamp(startAt, 0, Math.max(0, v.duration - 0.1))
        }
        refresh()
        if (playRequested.current) void v.play().catch(error => { if (error.name === 'NotAllowedError') { sourceStarted = true; setPaused(true); setWaiting(false) } else if (error.name !== 'AbortError') fail() })
      })
      on('durationchange', refresh); on('progress', refresh)
      on('play', () => { startup.setEnabled(playRequested.current); setPaused(false); wake() })
      const takeOver = () => {
        startup.finish()
        sourceStarted = true; started.current = true; activeSource.current = source; sourceHealthy.current = true
        bufferScene.current = 'playing'; bufferSamples.current = []
        handoffPending.current = false
        bridgeActive.current = false
        if (handoff.current?.hasAttribute('data-visible')) {
          handoff.current?.removeAttribute('data-visible')
          clearTimeout(handoffTimer.current)
          handoffTimer.current = setTimeout(() => { if (!handoff.current?.hasAttribute('data-visible')) handoff.current?.removeAttribute('src') }, 240)
        }
      }
      on('playing', () => {
        takeOver(); alive()
        buffering = false
        try {
          const quality = v.getVideoPlaybackQuality()
          frameState = createFrameRateState()
          frameState = sampleFrameRate(frameState, { at: Date.now(), totalFrames: quality.totalVideoFrames, droppedFrames: quality.droppedVideoFrames }, activeSpeed.current, requestedSpeed.current).state
        } catch { frameState = createFrameRateState() }
        setPaused(false); setWaiting(false); refresh(); wake()
      })
      on('pause', () => { startup.setEnabled(false); frameState = createFrameRateState(); setPaused(true); setWaiting(false); setIdle(false); void save() })
      on('waiting', () => { frameState = createFrameRateState(); buffering = true; if (!v.paused) setWaiting(true) })
      on('seeking', () => { seekRevision.current++; frameState = createFrameRateState(); bufferSamples.current = []; alive(); setWaiting(!v.paused); refresh() })
      on('seeked', () => { frameState = createFrameRateState(); buffering = false; bufferScene.current = 'seek'; setWaiting(false); refresh(); void save() })
      on('canplay', () => {
        frameState = createFrameRateState(); setWaiting(false); refresh()
        if (!playRequested.current && !v.seeking) { takeOver(); setPaused(true) }
      })
      on('timeupdate', () => {
        refresh()
        const current = latest.current
        // The next episode's source is chosen before this one ends, so it starts without a wait.
        const following = nextEpisode(current.item, episode)
        if (following !== undefined && prepared.current !== following && v.duration > 0 && v.duration - v.currentTime <= PREPARE_NEXT_SECONDS) {
          prepared.current = following
          void window.panda.data.playback(item.id, following, sessionPreferences.wantedQuality(current.settings)).catch(() => {})
        }
        if (!v.paused && current.settings.skipIntro && source.intro && v.currentTime >= source.intro.start && v.currentTime < source.intro.end) v.currentTime = Math.min(source.intro.end, v.duration)
        if (started.current && Date.now() - savingAt.current >= HISTORY_SAVE_SECONDS * 1000) void save()
        if (!v.paused && !v.seeking && current.settings.skipIntro && source.outro !== undefined && v.currentTime >= source.outro && v.currentTime < v.duration) {
          if (current.settings.autoNext && !current.cancelled && following !== undefined) next()
          else v.currentTime = v.duration
        }
      })
      on('ended', advance)
      on('error', () => { if (!hls.current) fail() })
      if (source.format === 'hls' && Hls.isSupported()) {
        // Keep a larger forward buffer for the rotating public CDNs, while bounding the reverse
        // buffer so long viewing sessions do not retain hundreds of megabytes in the renderer.
        // Failed fragments retry briefly, then the player watchdog can move to another source.
        const instance = new Hls({
          enableWorker: true,
          capLevelToPlayerSize: true,
          startFragPrefetch: true,
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
        instance.on(Hls.Events.MANIFEST_PARSED, (_event, manifest) => {
          const actual = manifest.levels.flatMap((level, index) => { const quality = resolutionQuality(level.width, level.height); return quality ? [{ quality, index, bitrate: level.bitrate }] : [] })
          setLevels(actual)
          const preferred = qualityLevelIndex(actual, sessionPreferences.quality ?? quality)
          if (preferred !== undefined) { instance.currentLevel = preferred; instance.autoLevelCapping = preferred }
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
      startup.setEnabled(playRequested.current)
      // A source can die in the middle of an episode without ever reporting an error.
      const watchdog = setInterval(() => {
        const now = Date.now()
        const elapsed = Math.min(5, Math.max(0, (now - lastHealthAt) / 1000))
        lastHealthAt = now
        if (sourceStarted && !v.paused && !v.ended && !v.seeking) {
          if (Math.abs(v.currentTime - lastHealthPosition) < 0.05) healthStallSeconds += elapsed
          else healthPlaySeconds += elapsed
        }
        lastHealthPosition = v.currentTime
        if (sourceStarted && source.sourceKey && now >= nextHealthFlush) {
          nextHealthFlush = now + 5000
          const play = healthPlaySeconds, stall = healthStallSeconds
          healthPlaySeconds = 0; healthStallSeconds = 0
          void window.panda.sources.observe(source.sourceKey, play, stall).catch(() => {})
        }
        if (v.paused || v.ended || v.seeking || latest.current.problem) {
          bufferSamples.current = []
          lastPosition = v.currentTime; alive(); return
        }
        const advanced = playbackProgress(lastPosition, v.currentTime, v.seeking)
        if (advanced !== undefined) { lastPosition = advanced; alive() }
        const rules = playbackRules.current
        if (rules) {
          const sample = { at: now, position: v.currentTime, ...playbackBuffer(v.buffered, v.currentTime, v.duration) }
          bufferSamples.current = [...bufferSamples.current.filter(value => now - value.at <= 30_000), sample]
          const scene = sourceStarted ? bufferScene.current : 'startup'
          bufferScene.current = 'playing'
          const verdict = shouldTakeOver(scene, bufferSamples.current, rules.buffer)
          // A short HLS buffer can keep decoding at full speed. Give a waiting
          // playhead time to refill before spending an automatic switch.
          const waitingForRefill = buffering && latest.current.hasAlternative &&
            now - progressAt >= rules.buffer.playingRiseWindowSec * 1000
          if (verdict.reason === 'stalled' || (verdict.reason === 'low-buffer' && waitingForRefill)) {
            alive(); fail(); return
          }
        }
        if (sourceStarted && now - progressAt > (rules?.buffer.stallPositionSec ?? STALL_MS / 1000) * 1000) { alive(); fail() }
      }, 1000)
      const frameMonitor = setInterval(() => {
        if (!active || v.paused || v.ended || v.seeking || v.readyState < 2) { frameState = createFrameRateState(); return }
        try {
          const quality = v.getVideoPlaybackQuality()
          const result = sampleFrameRate(frameState, { at: Date.now(), totalFrames: quality.totalVideoFrames, droppedFrames: quality.droppedVideoFrames }, activeSpeed.current, requestedSpeed.current)
          frameState = result.state
          if (result.rate === activeSpeed.current) return
          const reduced = result.rate < activeSpeed.current
          activeSpeed.current = result.rate
          sessionPreferences.activeSpeed = result.rate
          v.defaultPlaybackRate = result.rate; v.playbackRate = result.rate
          setSpeed(result.rate)
          notify(fmt(reduced ? extra.speedReduced : extra.speedRestored, { speed: result.rate }))
          frameState = createFrameRateState()
        } catch { frameState = createFrameRateState() }
      }, 2000)
      detachMedia.current = () => {
        active = false; startup.finish(); clearInterval(watchdog); clearInterval(frameMonitor)
        if (source.sourceKey && (healthPlaySeconds > 0 || healthStallSeconds > 0)) {
          void window.panda.sources.observe(source.sourceKey, healthPlaySeconds, healthStallSeconds).catch(() => {})
        }
        if (startupWatch.current === startup) startupWatch.current = null
        void save(v)
        if (handoffPending.current && v.currentTime > 0) retryPosition.current = v.currentTime
        if (handoffPending.current && v.readyState >= 2 && v.videoWidth > 0 && v.videoHeight > 0 && handoff.current) {
          clearTimeout(handoffTimer.current)
          try {
            const canvas = document.createElement('canvas')
            const scale = Math.min(1, 1280 / v.videoWidth, 720 / v.videoHeight)
            canvas.width = Math.max(1, Math.floor(v.videoWidth * scale))
            canvas.height = Math.max(1, Math.floor(v.videoHeight * scale))
            canvas.getContext('2d')?.drawImage(v, 0, 0, canvas.width, canvas.height)
            handoff.current.src = canvas.toDataURL('image/jpeg', 0.78)
            handoff.current.setAttribute('data-visible', '')
          } catch { /* Some streams forbid snapshots; a failed capture does not interrupt playback. */ }
        }
        listeners.forEach(([name, listener]) => v.removeEventListener(name, listener))
        hls.current?.destroy(); hls.current = null
        v.pause(); v.removeAttribute('src'); v.load()
      }
    }
    void initialize().catch(error => {
      if (signal.aborted) return
      const reason = error instanceof Error ? error.message : ''
      if (source.sourceKey && ['frames-unavailable', 'alignment-media-unavailable', 'alignment-budget-exceeded',
        'duration-suspect', 'history-inconsistent', 'no-match', 'over-budget'].includes(reason)) {
        console.info('[alignment]', source.sourceKey, reason)
      }
      handoffPending.current = false
      bridgeActive.current = false
      setWaiting(false)
      if (sourceHealthy.current) { setReady(true); notify(extra.lineSwitchFailed) }
      else { setProblem(new Error(extra.playerRetry)); setIdle(false) }
    })
    return () => controller.abort()
  }, [playback.data, playback.loading, playback.error])

  useEffect(() => {
    if (!currentMedia) return
    let active = true
    // Asked once the episode has a source, so the answer says which one that is.
    void window.panda.data.sources(item.id, episode).then(value => { if (active) setLines(value) }, () => {})
    return () => { active = false }
  }, [currentMedia, catalogueRevision])

  const ratio = (event: PointerEvent<HTMLElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    return bounds.width ? clamp((event.clientX - bounds.left) / bounds.width) : 0
  }
  return <Dialog.Root open={panelOpen} onOpenChange={setPanelOpen}><main className="player" ref={root} data-paused={dataAttr(paused)} data-waiting={dataAttr(busy && !error)} data-error={dataAttr(error)} data-idle={dataAttr(idle && !error && !busy)} onPointerDown={wake} onFocus={wake} onKeyDown={wake}>
    <video className="player__video" ref={video} playsInline preload="auto" crossOrigin="anonymous" poster={item.backdrop ?? undefined} onClick={play} onDoubleClick={toggleFullscreen} />
    <img className="player__handoff" ref={handoff} alt="" aria-hidden="true" />
    <div className="player__shade" />
    <header className="player__top" inert={idle && !error && !busy}><IconButton name="arrow-left" className="icon-btn--lg" label={t.action.back} shortcut="Esc" onClick={leave} /><div className="player__heading"><span className="player__title" role="heading" aria-level={1} title={item.title}>{item.title}</span>{episodeHeading(item, episode) && <span className="player__ep">{episodeHeading(item, episode)}</span>}</div></header>
    <div className="player__center"><button className="player__bigplay" aria-label={t.player.play} tabIndex={-1} onClick={play} disabled={!ready}><Icon name="play" /></button>{busy && !error && <span className="spinner" role="status" aria-label={extra.loading} />}<div className="player__error empty" role="alert"><Icon name="alert" size="xl" /><p className="empty__text">{error ? errorText(error) : t.player.error}</p><button className="btn" onClick={() => retry()}>{t.action.retry}</button></div></div>
    <div className="osd" role="status" data-open={dataAttr(osd)}>{osd && <><Icon name={osd.name} /><span>{osd.text}</span></>}</div>
    <button className="btn btn--glass player__skip" data-open={dataAttr(showSkipIntro(time.position, currentMedia ?? {}, state.settings) && upNext === null && !panelOpen)} onClick={() => { if (currentMedia?.intro) seekTo(currentMedia.intro.end) }}>{t.player.skipIntro}</button>
    <div className="upnext" data-open={dataAttr(upNext !== null && !panelOpen)}><div className="upnext__label">{upNext !== null && fmt(t.player.upNext, { n: upNext })}</div><div className="upnext__title">{upcoming !== undefined && episodeHeading(item, upcoming)}</div><div className="upnext__actions"><button className="btn btn--primary btn--sm" onClick={next}>{t.player.playNow}</button><button className="btn btn--ghost btn--sm" onClick={() => setCancelled(true)}>{t.action.cancel}</button></div></div>
    <div className="player__bottom" inert={idle && !error && !busy}>
      <div className="seek" role="slider" tabIndex={ready ? 0 : -1} aria-label={t.player.seek} aria-disabled={!ready} aria-valuemin={0} aria-valuemax={time.duration} aria-valuenow={Math.floor(position)} aria-valuetext={clock(position)} data-dragging={dataAttr(dragPosition !== null)}
        style={{ '--p': (time.duration ? 100 * position / time.duration : 0) + '%', '--h': hover * 100 + '%' } as CSSProperties}
        onPointerDown={event => { if (!ready) return; event.currentTarget.setPointerCapture(event.pointerId); setDragPosition(ratio(event) * time.duration) }}
        onPointerMove={event => { const p = ratio(event); setHover(p); if (dragPosition !== null) setDragPosition(p * time.duration) }}
        onPointerUp={event => { if (dragPosition !== null) { seekTo(ratio(event) * time.duration); setDragPosition(null) } }}
        onPointerCancel={() => setDragPosition(null)}
        onKeyDown={event => {
          if (!ready || event.ctrlKey || event.metaKey || event.altKey) return
          const step = event.key === 'ArrowRight' || event.key === 'ArrowUp' ? SEEK_STEP_SECONDS
            : event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -SEEK_STEP_SECONDS
              : event.key === 'PageUp' ? SEEK_STEP_SECONDS * 6 : event.key === 'PageDown' ? -SEEK_STEP_SECONDS * 6 : 0
          if (!step && event.key !== 'Home' && event.key !== 'End') return
          event.preventDefault()
          seekTo(event.key === 'Home' ? 0 : event.key === 'End' ? time.duration : (video.current?.currentTime ?? time.position) + step)
          if (step) showOsd(step > 0 ? 'forward' : 'rewind', fmt(t.player.seconds, { n: Math.abs(step) }))
        }}>
        <div className="seek__track">{time.buffered.map((range, i) => <i className="seek__buffer" key={i} style={{ left: range.start / time.duration * 100 + '%', width: (range.end - range.start) / time.duration * 100 + '%' }} />)}<i className="seek__played" /></div><i className="seek__thumb" /><span className="seek__tip">{clock(hover * time.duration)}</span>
      </div>
      <div className="player__bar"><div className="player__group">
        <IconButton name={paused ? 'play' : 'pause'} className="player__play" label={paused ? t.player.play : t.player.pause} shortcut="Space" onClick={play} disabled={Boolean(error)} side="top" />
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
        {item.episodes && <Dialog.Trigger className="btn btn--ghost">{t.player.episodes}</Dialog.Trigger>}
        <SelectMenu className="btn btn--ghost" label={t.player.speed} side="top" value={speed} items={SPEEDS.map(value => ({ value, label: speedLabel(value) }))} onChange={changeSpeed}>{speedButtonLabel(speed)}</SelectMenu>
        {choices.length > 1 && <SelectMenu className="btn btn--ghost" label={t.player.quality} side="top" value={actualQuality ?? currentMedia?.quality ?? quality} items={choices.map(value => ({ value, label: value }))} onChange={changeQuality}>{actualQuality ?? currentMedia?.quality ?? t.player.quality}</SelectMenu>}
        {lines && lines.list.length > 1 && <SelectMenu className="btn btn--ghost" label={extra.line} side="top" value={lines.current ?? ''} items={lines.list.map(entry => ({ value: entry.key, label: entry.name }))} onChange={changeLine}>{extra.line}</SelectMenu>}
        {document.pictureInPictureEnabled && <IconButton name="pip" label={t.player.pip} onClick={() => void pip()} disabled={!ready} side="top" />}
        <IconButton name={fullscreen ? 'fullscreen-exit' : 'fullscreen'} label={fullscreen ? t.player.exitFullscreen : t.player.fullscreen} shortcut="F" onClick={toggleFullscreen} side="top" />
      </div></div>
    </div>
    {item.episodes && <Dialog.Portal container={root}>
      <Dialog.Backdrop className="player__panel-scrim" />
      <Dialog.Popup className="player__panel player__panel--dialog" ref={panel} initialFocus={() => {
        const current = panel.current?.querySelector<HTMLElement>('[data-current]')
        current?.scrollIntoView({ block: 'center' })
        return current ?? panelClose.current ?? true
      }}>
        <div className="player__panel-head"><Dialog.Title className="player__panel-title">{t.player.episodes}</Dialog.Title><Dialog.Close ref={panelClose} className="icon-btn" aria-label={t.action.close}><Icon name="close" /></Dialog.Close></div>
        <div className="player__panel-body"><div className={item.episodeTitles?.length ? 'eplist' : 'eps'}><EpisodeCells item={item} current={episode} replace /></div></div>
      </Dialog.Popup>
    </Dialog.Portal>}
  </main></Dialog.Root>
}
