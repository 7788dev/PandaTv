// 播放页。结构与 styles/player.css 顶部的注释一一对应。
//
// 原型没有真实片源：画面循环播放一段公开测试视频（没有网络时只显示剧照），
// 时间轴按这部片子的时长「虚拟」出来，所以进度、续播、下一集倒计时都和真实使用时一样。
// 正式应用直接读 <video> 的 currentTime / duration，不需要这里的 vt / tick。
//
// 调试用：地址后面加 ?state=paused | waiting | error | skip | upnext | panel 可以直接看到对应状态。
import { $, $$, esc, fmt, icon, tip, t, data, item, store, isSeries, isFinished, episodeLabel, clock, speedLabel, SPEEDS, QUALITIES, nav } from './core.js'
import { openMenu } from './ui.js'
import { episodeCells } from './views.js'

const INTRO = 90 // 演示：剧集和动漫的片头长度（秒）。正式数据由接口按集返回，没有就不显示「跳过片头」
const UPNEXT = 10 // 距离结束还有多少秒时出现「即将播放」
const IDLE = 2500 // 鼠标静止多久后隐藏控件（毫秒）
const session = { rate: null, quality: null } // 在播放页里改的倍速、清晰度只在本次运行内有效，不改「设置」里的默认值

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v))

export function player(host, id, ep, query) {
  const it = item(id)
  if (!it) {
    setTimeout(() => nav.replace('#/'))
    return
  }
  const c = t()
  const set = store.state.settings
  const force = query.get('state')
  const series = isSeries(it)
  const count = it.episodes || 1
  const h = store.historyOf(id)
  const episode = series ? clamp(ep || h?.episode || 1, 1, count) : 1
  const total = it.runtime * 60
  const hasNext = series && episode < count
  const intro = it.type === 'tv' || it.type === 'anime' ? INTRO : 0
  const resume = h && h.episode === episode && !isFinished(h) ? Math.min(h.position, total - 1) : 0
  const epText = (n) => (series ? [episodeLabel(it, n), it.episodeTitles?.[n - 1]].filter(Boolean).join(' · ') : '')

  let vt = resume || (set.skipIntro ? intro : 0) // 当前播放位置（秒）
  let rate = session.rate ?? set.speed
  let quality = session.quality ?? set.quality
  let playing = false
  let started = false
  let waiting = false
  let dragging = false
  let panelOpen = false
  let cancelled = false // 用户点了「取消」：这一集不再自动跳下一集

  host.innerHTML = `<div class="player" data-paused>
    <video class="player__video" playsinline preload="auto"${it.backdrop ? ` poster="/${esc(it.backdrop)}"` : ''}></video>
    <div class="player__shade"></div>
    <header class="player__top">
      <button class="icon-btn icon-btn--lg" data-act="back" ${tip(c.action.back, 'Esc')}>${icon('arrow-left')}</button>
      <div class="player__heading"><span class="player__title">${esc(it.title)}</span>${series ? `<span class="player__ep">${esc(epText(episode))}</span>` : ''}</div>
    </header>
    <div class="player__center">
      <button class="player__bigplay" data-act="toggle" aria-label="${esc(c.player.play)}" tabindex="-1">${icon('play')}</button>
      <span class="spinner"></span>
      <div class="player__error empty">${icon('alert', 'xl')}<p class="empty__text">${esc(c.player.error)}</p><button class="btn" data-act="retry">${esc(c.action.retry)}</button></div>
    </div>
    <div class="osd" role="status"></div>
    <button class="btn btn--glass player__skip" data-act="skip">${esc(c.player.skipIntro)}</button>
    <div class="upnext">
      <div class="upnext__label"></div>
      <div class="upnext__title">${esc(epText(episode + 1))}</div>
      <div class="upnext__actions">
        <button class="btn btn--primary btn--sm" data-act="next">${esc(c.player.playNow)}</button>
        <button class="btn btn--ghost btn--sm" data-act="cancel-next">${esc(c.action.cancel)}</button>
      </div>
    </div>
    <div class="player__bottom">
      <div class="seek" role="slider" tabindex="0" aria-label="${esc(c.player.seek)}" aria-valuemin="0" aria-valuemax="${total}">
        <div class="seek__track"><i class="seek__buffer"></i><i class="seek__played"></i></div>
        <i class="seek__thumb"></i>
        <span class="seek__tip"></span>
      </div>
      <div class="player__bar">
        <div class="player__group">
          <button class="icon-btn player__play" data-act="toggle" data-tip-side="top" ${tip(c.player.play, 'Space')}>${icon('play')}</button>
          ${hasNext ? `<button class="icon-btn" data-act="next" data-tip-side="top" ${tip(c.player.next, 'N')}>${icon('next')}</button>` : ''}
          <div class="player__volume">
            <button class="icon-btn" data-act="mute" data-tip-side="top" ${tip(c.player.mute, 'M')}>${icon('volume')}</button>
            <div class="slider" role="slider" tabindex="0" aria-label="${esc(c.player.volume)}" aria-valuemin="0" aria-valuemax="100">
              <div class="slider__control"><div class="slider__track"><div class="slider__range"></div><div class="slider__thumb" style="position:absolute;top:50%;translate:-50% -50%"></div></div></div>
            </div>
          </div>
          <div class="player__time"><time></time><span> / ${clock(total)}</span></div>
        </div>
        <div class="player__group">
          ${series ? `<button class="btn btn--ghost" data-act="panel">${esc(c.player.episodes)}</button>` : ''}
          <button class="btn btn--ghost" data-act="speed"></button>
          <button class="btn btn--ghost" data-act="quality"></button>
          ${document.pictureInPictureEnabled ? `<button class="icon-btn" data-act="pip" data-tip-side="top" ${tip(c.player.pip)}>${icon('pip')}</button>` : ''}
          <button class="icon-btn" data-act="fullscreen" data-tip-side="top" ${tip(c.player.fullscreen, 'F')}>${icon('fullscreen')}</button>
        </div>
      </div>
    </div>
    ${
      series
        ? `<aside class="player__panel">
            <div class="player__panel-head">
              <h2 class="player__panel-title">${esc(c.player.episodes)}</h2>
              <button class="icon-btn" data-act="panel" aria-label="${esc(c.action.close)}">${icon('close')}</button>
            </div>
            <div class="player__panel-body"><div class="${it.episodeTitles ? 'eplist' : 'eps'}">${episodeCells(it, episode, { replace: true })}</div></div>
          </aside>`
        : ''
    }
  </div>`

  const app = host.closest('.app')
  const root = $('.player', host)
  const video = $('video', root)
  const seek = $('.seek', root)
  const seekTip = $('.seek__tip', root)
  const timeEl = $('.player__time time', root)
  const skipEl = $('.player__skip', root)
  const upEl = $('.upnext', root)
  const upLabel = $('.upnext__label', root)
  const osdEl = $('.osd', root)
  const panelEl = $('.player__panel', root)
  const slider = $('.slider', root)
  const speedBtn = $('[data-act="speed"]', root)
  const qualityBtn = $('[data-act="quality"]', root)
  const fsBtn = $('[data-act="fullscreen"]', root)
  const muteBtn = $('[data-act="mute"]', root)

  /** 改按钮的名称：读屏用的 aria-label 和悬停提示一起换 */
  const label = (btn, text) => {
    btn.setAttribute('aria-label', text)
    if (btn.hasAttribute('data-tip')) btn.setAttribute('data-tip', text)
  }

  // ── 画面状态 ──
  let shown = -1
  const paint = () => {
    const p = (vt / total) * 100
    seek.style.setProperty('--p', `${p}%`)
    seek.style.setProperty('--b', `${Math.min(100, p + 6)}%`)
    const sec = Math.floor(vt)
    if (sec !== shown) {
      shown = sec
      timeEl.textContent = clock(vt)
      seek.setAttribute('aria-valuenow', sec)
      seek.setAttribute('aria-valuetext', clock(vt))
    }
    const left = total - vt
    const showSkip = force === 'skip' || (intro > 0 && !set.skipIntro && vt >= 2 && vt < intro - 2)
    const showNext = force === 'upnext' || (hasNext && set.autoNext && !cancelled && left <= UPNEXT && left > 0)
    skipEl.toggleAttribute('data-open', showSkip && !showNext && !panelOpen)
    upEl.toggleAttribute('data-open', showNext && !panelOpen)
    if (showNext) upLabel.textContent = fmt(c.player.upNext, { n: Math.max(1, Math.ceil(Math.min(left, UPNEXT))) })
  }

  const save = () => {
    if (!started) return
    // 看完一集且还有下一集：记成「下一集从头」，这样首页的继续观看会指向下一集
    if (vt / total > 0.95 && hasNext) store.record(id, episode + 1, 0, total)
    else store.record(id, episode, Math.floor(vt), total)
  }

  const seekTo = (x) => {
    vt = clamp(x, 0, total)
    if (video.duration) video.currentTime = vt % video.duration
    paint()
  }

  const setPlaying = (on) => {
    if (on && vt >= total) seekTo(0) // 播完后再点播放：从头开始
    playing = on
    if (on) started = true
    root.toggleAttribute('data-paused', !on)
    for (const b of $$('[data-act="toggle"]', root)) {
      b.innerHTML = icon(on ? 'pause' : 'play')
      label(b, on ? c.player.pause : c.player.play)
    }
    if (on) {
      // 浏览器不允许自动播放时，回到暂停状态，等用户点一下
      video.play().catch((err) => err.name === 'NotAllowedError' && setPlaying(false))
    } else {
      video.pause()
      save()
    }
    wake()
  }
  const toggle = () => setPlaying(!playing)
  const go = (n) => nav.replace(`#/play/${id}/${n}`)
  const back = () => nav.back(`#/detail/${id}`)

  // ── 瞬时反馈 ──
  let osdTimer = 0
  const osd = (name, text) => {
    osdEl.innerHTML = `${icon(name)}<span>${esc(text)}</span>`
    osdEl.setAttribute('data-open', '')
    clearTimeout(osdTimer)
    osdTimer = setTimeout(() => osdEl.removeAttribute('data-open'), 900)
  }

  // ── 音量 ──
  const level = () => (set.muted ? 0 : set.volume)
  const volumeIcon = () => (level() === 0 ? 'volume-mute' : level() < 0.5 ? 'volume-low' : 'volume')
  const paintVolume = () => {
    video.volume = set.volume
    video.muted = set.muted
    const pct = `${level() * 100}%`
    $('.slider__range', slider).style.width = pct
    $('.slider__thumb', slider).style.left = pct
    slider.setAttribute('aria-valuenow', Math.round(level() * 100))
    muteBtn.innerHTML = icon(volumeIcon())
    label(muteBtn, level() === 0 ? c.player.unmute : c.player.mute)
  }
  const setVolume = (v, show) => {
    set.volume = clamp(Math.round(v * 100) / 100)
    set.muted = false
    paintVolume()
    store.save()
    if (show) osd(volumeIcon(), `${Math.round(set.volume * 100)}%`)
  }
  const mute = () => {
    set.muted = !set.muted
    if (!set.muted && set.volume === 0) set.volume = 0.5
    paintVolume()
    store.save()
    osd(volumeIcon(), set.muted ? c.player.mute : `${Math.round(set.volume * 100)}%`)
  }

  // ── 倍速 / 清晰度 ──
  const paintMenus = () => {
    speedBtn.textContent = rate === 1 ? c.player.speed : speedLabel(rate) // 正常速度时显示「倍速」二字
    qualityBtn.textContent = quality
    video.playbackRate = rate
  }
  const openSpeed = () =>
    openMenu(speedBtn, {
      label: c.player.speed,
      items: SPEEDS.map((v) => ({ value: v, label: speedLabel(v) })),
      value: rate,
      side: 'top',
      onSelect: (v) => {
        rate = session.rate = v
        paintMenus()
      },
    })
  const openQuality = () =>
    openMenu(qualityBtn, {
      label: c.player.quality,
      items: QUALITIES.map((q) => ({ value: q, label: q })),
      value: quality,
      side: 'top',
      onSelect: (v) => {
        quality = session.quality = v
        paintMenus()
      },
    })

  // ── 选集面板 ──
  const setPanel = (on) => {
    if (!panelEl) return
    panelOpen = on
    panelEl.toggleAttribute('data-open', on)
    $('.player__bar [data-act="panel"]', root).toggleAttribute('data-popup-open', on)
    if (on) $('[data-current]', panelEl)?.scrollIntoView({ block: 'center' })
    paint()
    wake()
  }

  // ── 全屏 / 画中画 ──
  const fullscreen = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.().catch(() => {}))
  const onFullscreen = () => {
    const on = Boolean(document.fullscreenElement)
    app.toggleAttribute('data-fullscreen', on)
    fsBtn.innerHTML = icon(on ? 'fullscreen-exit' : 'fullscreen')
    label(fsBtn, on ? c.player.exitFullscreen : c.player.fullscreen)
  }
  const pip = () => (document.pictureInPictureElement ? document.exitPictureInPicture() : video.requestPictureInPicture?.().catch(() => {}))

  // ── 鼠标静止后隐藏控件 ──
  let idleTimer = 0
  let lastXY = ''
  const busy = () => !playing || panelOpen || dragging || root.hasAttribute('data-error') || Boolean($('[data-popup-open]', root)) || Boolean($('.player__top:hover, .player__bottom:hover', root))
  function wake() {
    root.removeAttribute('data-idle')
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => (busy() ? wake() : root.setAttribute('data-idle', '')), IDLE)
  }
  // 控件淡出时浏览器会补发一次坐标不变的 pointermove，必须比较坐标，否则刚隐藏就又被唤醒
  const onMove = (e) => {
    const xy = `${e.clientX},${e.clientY}`
    if (xy === lastXY) return
    lastXY = xy
    wake()
  }

  // ── 进度条 ──
  const ratio = (e) => {
    const r = seek.getBoundingClientRect()
    return clamp((e.clientX - r.left) / r.width)
  }
  seek.addEventListener('pointermove', (e) => {
    const p = ratio(e)
    seek.style.setProperty('--h', `${p * 100}%`)
    seekTip.textContent = clock(p * total)
    if (dragging) {
      vt = p * total
      paint()
    }
  })
  seek.addEventListener('pointerdown', (e) => {
    seek.setPointerCapture(e.pointerId)
    dragging = true
    seek.setAttribute('data-dragging', '')
    vt = ratio(e) * total
    paint()
  })
  const endDrag = () => {
    if (!dragging) return
    dragging = false
    seek.removeAttribute('data-dragging')
    seekTo(vt)
  }
  seek.addEventListener('pointerup', endDrag)
  seek.addEventListener('pointercancel', endDrag)

  // ── 音量滑杆（正式应用用 Base UI Slider，这里只是模拟） ──
  const control = $('.slider__control', slider)
  let volDrag = false
  const volRatio = (e) => {
    const r = control.getBoundingClientRect()
    return clamp((e.clientX - r.left) / r.width)
  }
  const setVolDrag = (on) => {
    volDrag = on
    slider.toggleAttribute('data-dragging', on)
    $('.slider__thumb', slider).toggleAttribute('data-dragging', on)
  }
  control.addEventListener('pointerdown', (e) => {
    control.setPointerCapture(e.pointerId)
    setVolDrag(true)
    setVolume(volRatio(e))
  })
  control.addEventListener('pointermove', (e) => volDrag && setVolume(volRatio(e)))
  control.addEventListener('pointerup', () => setVolDrag(false))
  control.addEventListener('pointercancel', () => setVolDrag(false))

  // ── 点击 ──
  const acts = {
    back,
    toggle,
    mute,
    pip,
    fullscreen,
    next: () => hasNext && go(episode + 1),
    skip: () => seekTo(intro),
    panel: () => setPanel(!panelOpen),
    speed: openSpeed,
    quality: openQuality,
    'cancel-next': () => {
      cancelled = true
      paint()
    },
    retry: () => {
      root.removeAttribute('data-error')
      setPlaying(true)
    },
  }
  root.addEventListener('click', (e) => acts[e.target.closest('[data-act]')?.dataset.act]?.())
  video.addEventListener('click', () => (panelOpen ? setPanel(false) : toggle()))
  video.addEventListener('dblclick', fullscreen)
  root.addEventListener('pointermove', onMove)
  root.addEventListener('pointerdown', wake)

  // ── 键盘 ──
  const onKey = (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || $('.menu')) return
    wake()
    const onButton = Boolean(e.target.closest?.('button, a'))
    const onSlider = Boolean(e.target.closest?.('.slider'))
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
    if (key === ' ' && onButton) return // 焦点在某个按钮上：空格归那个按钮
    if (key === ' ' || key === 'k') toggle()
    else if (key === 'ArrowLeft' || key === 'ArrowRight') {
      const d = key === 'ArrowRight' ? 1 : -1
      if (onSlider) setVolume(level() + d * 0.05)
      else {
        seekTo(vt + d * 10)
        osd(d > 0 ? 'forward' : 'rewind', fmt(c.player.seconds, { n: 10 }))
      }
    } else if (key === 'ArrowUp' || key === 'ArrowDown') setVolume(level() + (key === 'ArrowUp' ? 0.05 : -0.05), true)
    else if (key === 'm') mute()
    else if (key === 'f') fullscreen()
    else if (key === 'n') acts.next()
    else if (key === 'Escape') {
      if (panelOpen) setPanel(false)
      else if (document.fullscreenElement) document.exitFullscreen()
      else back()
    } else return
    e.preventDefault()
  }
  document.addEventListener('keydown', onKey)
  document.addEventListener('fullscreenchange', onFullscreen)

  // ── 视频 ──
  video.loop = true
  video.addEventListener('waiting', () => {
    waiting = true
    if (playing) root.setAttribute('data-waiting', '')
  })
  for (const ev of ['playing', 'canplay', 'error'])
    video.addEventListener(ev, () => {
      waiting = false
      if (force !== 'waiting') root.removeAttribute('data-waiting')
    })
  video.addEventListener('loadedmetadata', () => (video.currentTime = vt % video.duration), { once: true })
  video.src = data.catalog.sources.mp4

  // ── 时钟 ──
  let raf = 0
  let last = performance.now()
  let sinceSave = 0
  const tick = (now) => {
    raf = requestAnimationFrame(tick)
    const dt = Math.min(0.25, (now - last) / 1000)
    last = now
    if (!playing || waiting || dragging) return
    vt = Math.min(total, vt + dt * rate)
    paint()
    sinceSave += dt
    if (sinceSave > 5) {
      sinceSave = 0
      save()
    }
    if (vt < total) return
    // 播完了
    save()
    if (hasNext && set.autoNext && !cancelled) go(episode + 1)
    else setPlaying(false)
  }
  raf = requestAnimationFrame(tick)

  // ── 初始状态 ──
  paint()
  paintVolume()
  paintMenus()
  onFullscreen()
  if (force === 'error') root.setAttribute('data-error', '')
  else if (force === 'waiting') {
    root.setAttribute('data-waiting', '')
    root.removeAttribute('data-paused')
  } else if (force !== 'paused') setPlaying(true)
  if (force === 'panel') setPanel(true)
  wake()

  return {
    cleanup() {
      cancelAnimationFrame(raf)
      clearTimeout(idleTimer)
      clearTimeout(osdTimer)
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('fullscreenchange', onFullscreen)
      save()
      video.pause()
      video.removeAttribute('src')
      video.load()
      // 离开播放页（而不是切到另一集）时退出全屏
      if (!location.hash.startsWith('#/play/')) {
        app.removeAttribute('data-fullscreen')
        if (document.fullscreenElement) document.exitFullscreen()
      }
    },
  }
}
