import Hls from 'hls.js'
import type { Playback } from '../contract/types'
import { similarity } from '../shared/rules/alignment'
import type { FrameSample, ScoredSample } from '../shared/rules/types'

function luminance(pixels: Uint8ClampedArray, i: number): number {
  return pixels[i]! * 0.299 + pixels[i + 1]! * 0.587 + pixels[i + 2]! * 0.114
}

export function frameSample(pixels: Uint8ClampedArray): FrameSample {
  let hash = ''
  let nibble = 0
  let bits = 0
  let min = Infinity, max = -Infinity
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const index = (y * 9 + x) * 4
      const left = luminance(pixels, index), right = luminance(pixels, index + 4)
      min = Math.min(min, left, right)
      max = Math.max(max, left, right)
      nibble = (nibble << 1) | Number(left > right)
      if (++bits === 4) {
        hash += nibble.toString(16)
        nibble = 0
        bits = 0
      }
    }
  }
  // Near-flat frames, including slightly noisy encodes of black, carry no reliable anchor.
  return max - min >= 4 ? { valid: true, hash } : { valid: false, hash: '' }
}

export function videoFrameSample(video: HTMLVideoElement): FrameSample {
  if (video.seeking || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.videoWidth < 1 || video.videoHeight < 1) {
    return { valid: false, hash: '' }
  }
  try {
    const canvas = document.createElement('canvas')
    canvas.width = 9
    canvas.height = 8
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) return { valid: false, hash: '' }
    context.imageSmoothingQuality = 'high'
    context.drawImage(video, 0, 0, canvas.width, canvas.height)
    return frameSample(context.getImageData(0, 0, canvas.width, canvas.height).data)
  } catch {
    return { valid: false, hash: '' }
  }
}

function waitForMedia(video: HTMLVideoElement, name: 'loadedmetadata' | 'seeked', signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const done = () => { cleanup(); resolve() }
    const stop = () => { cleanup(); reject(signal.reason) }
    const cleanup = () => {
      video.removeEventListener(name, done)
      signal.removeEventListener('abort', stop)
    }
    video.addEventListener(name, done, { once: true })
    signal.addEventListener('abort', stop, { once: true })
  })
}

export function waitForSeek(video: HTMLVideoElement, signal: AbortSignal): Promise<void> {
  return waitForMedia(video, 'seeked', signal)
}

/** The same abort signal covers attachment, metadata, play(), seeking and decoded frames. */
export async function scorePlaybackOffsets(
  playback: Playback, position: number, offsets: readonly number[], reference: FrameSample,
  budgetMs: number, parent?: AbortSignal,
): Promise<ScoredSample[]> {
  if (!reference.valid || !offsets.length || budgetMs <= 0) return []
  parent?.throwIfAborted()
  const controller = new AbortController()
  const signal = controller.signal
  const timeout = setTimeout(() => controller.abort(new Error('alignment-budget-exceeded')), budgetMs)
  const cancel = () => controller.abort(parent?.reason)
  parent?.addEventListener('abort', cancel, { once: true })
  const video = document.createElement('video')
  video.crossOrigin = 'anonymous'
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'
  const mediaError = () => controller.abort(new Error('alignment-media-unavailable'))
  video.addEventListener('error', mediaError)
  let hls: Hls | undefined
  const sample = async () => {
    if (playback.format === 'hls' && Hls.isSupported()) {
      hls = new Hls({ enableWorker: false, startPosition: position, maxBufferLength: 4, maxMaxBufferLength: 4 })
      hls.on(Hls.Events.ERROR, (_event, data) => { if (data.fatal) mediaError() })
      hls.loadSource(playback.url)
      hls.attachMedia(video)
    } else {
      video.src = playback.url
    }
    if (video.readyState < HTMLMediaElement.HAVE_METADATA) await waitForMedia(video, 'loadedmetadata', signal)
    await video.play()
    signal.throwIfAborted()
    // Freeze the sampling clock: seeked supplies the requested frame, whereas
    // waiting for the next presentation callback compares a later frame.
    video.pause()
    const scored: ScoredSample[] = []
    for (const offsetSeconds of offsets) {
      const duration = Number.isFinite(video.duration) ? video.duration : playback.duration ?? Infinity
      const target = position + offsetSeconds
      if (target < 0 || target >= duration) continue
      if (Math.abs(video.currentTime - target) > 0.001) {
        video.currentTime = target
        await waitForMedia(video, 'seeked', signal)
      }
      signal.throwIfAborted()
      const frame = videoFrameSample(video)
      scored.push({ offsetSeconds, similarity: similarity(reference, frame), valid: frame.valid })
    }
    return scored
  }
  try {
    const aborted = new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    return await Promise.race([aborted, sample()])
  } finally {
    clearTimeout(timeout)
    parent?.removeEventListener('abort', cancel)
    video.removeEventListener('error', mediaError)
    video.pause()
    hls?.destroy()
    video.removeAttribute('src')
    video.load()
  }
}
