import type { ChannelQuery, MediaType, Quality } from '../contract/types'
import { QUALITIES } from '../contract/constants'
import { t } from '../contract/copy'
import type { RpcResult } from '../shared/rpc'
import type { StateAction } from '../shared/api'
import { extra } from '../copy.extra'
import { DataError } from './data/http'
import type { DoubanDataSource } from './data/douban'
import type { PlaybackService, WorkHints } from './playback/service'
import { UserStore, validId } from './state'
import type { SourceHealthStore } from './health/store'
import type { OffsetCache } from './playback/offset-cache'
import { align } from './playback/alignment-engine'
import type { ResolvedAlignmentConfig, ResolvedBudgetConfig, ResolvedBufferConfig } from '../shared/rules/config'
import type { AlignEndpoint, DurationSource, ScoredSample } from '../shared/rules/types'

const types = ['tv', 'movie', 'variety', 'anime', 'doc']
export interface Services {
  data: DoubanDataSource
  playback: PlaybackService
  health?: SourceHealthStore
  offsets?: OffsetCache
  alignment?: ResolvedAlignmentConfig
  buffer?: ResolvedBufferConfig
  budget?: ResolvedBudgetConfig
  user: () => UserStore
  changed: () => void
  libraryRequests?: Map<string, AbortController>
  recovery?: () => import('../shared/api').StateRecovery
  recover?: (restoreBackup: boolean) => import('../contract/types').UserState
}
export function safeError(error: unknown, playback = false): { code: string; message: string } {
  if (error instanceof DataError) {
    const messages = { INVALID_INPUT: extra.invalidInput, NOT_FOUND: extra.notFound, NETWORK: t.state.offline, TIMEOUT: extra.timeout, RATE_LIMITED: extra.rateLimited, UPSTREAM: extra.unavailable, INVALID_RESPONSE: extra.unavailable, UNAVAILABLE: extra.unavailable, STORAGE: extra.saveError }
    return { code: error.code, message: messages[error.code] }
  }
  const message = error instanceof Error ? error.message : ''
  if (error instanceof Error && error.name === 'AbortError') return { code: 'CANCELLED', message: extra.unknownError }
  if (message === 'INVALID_INPUT') return { code: 'INVALID_INPUT', message: extra.invalidInput }
  if (message === 'STATE_CORRUPT') return { code: 'STORAGE', message: extra.stateCorrupt }
  if (message === 'STATE_WRITE_FAILED') return { code: 'STORAGE', message: extra.saveError }
  // Only our finite operational copy crosses IPC; never upstream URLs or stack traces.
  if ((Object.values(extra) as string[]).includes(message)) return { code: 'UNAVAILABLE', message }
  return { code: playback ? 'PLAYBACK' : 'INTERNAL', message: playback ? extra.playerRetry : extra.unknownError }
}
function invalid(): never { throw new DataError('INVALID_INPUT', 'Invalid bridge input') }
function string(value: unknown, max = 100): string {
  if (typeof value !== 'string' || value.length > max) return invalid()
  return value
}
function id(value: unknown): string { validId(value); return value }
function person(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{1,16}$/.test(value)) return invalid()
  return value
}
function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 10000) return invalid()
  return value
}
function finiteNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return invalid()
  return value
}
function decimal(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return invalid()
  return value
}
function alignEndpoint(value: unknown): AlignEndpoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const raw = value as Record<string, unknown>
  const sourceKey = string(raw.sourceKey, 40)
  const duration = raw.duration === undefined ? undefined : decimal(raw.duration)
  const durationSource = raw.durationSource === undefined ? undefined
    : ['hls-extinf', 'mp4-moov', 'missing'].includes(String(raw.durationSource))
      ? raw.durationSource as DurationSource : invalid()
  const fingerprint = raw.fingerprint === undefined ? undefined : string(raw.fingerprint, 80)
  return {
    sourceKey,
    ...(duration !== undefined ? { duration } : {}),
    ...(durationSource !== undefined ? { durationSource } : {}),
    ...(fingerprint !== undefined ? { fingerprint } : {}),
  }
}
function alignSamples(value: unknown): ScoredSample[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 5) return invalid()
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return invalid()
    const raw = item as Record<string, unknown>
    const similarity = decimal(raw.similarity)
    if (similarity > 1) return invalid()
    return { offsetSeconds: finiteNumber(raw.offsetSeconds), similarity, valid: raw.valid === true }
  })
}
function type(value: unknown): MediaType {
  if (typeof value !== 'string' || !types.includes(value)) return invalid()
  return value as MediaType
}
function query(value: unknown): ChannelQuery {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const raw = value as Record<string, unknown>
  if (!['hot', 'new', 'score'].includes(String(raw.sort))) return invalid()
  const result: ChannelQuery = { sort: raw.sort as ChannelQuery['sort'] }
  for (const key of ['genre', 'region', 'year'] as const) if (raw[key] !== undefined) result[key] = string(raw[key], 40)
  return result
}
/** What the metadata record says about the work that its card does not carry. */
function hints(data: DoubanDataSource, itemId: string): WorkHints {
  const record = data.getMetadata(itemId)
  return { single: record?.kind === 'movie', aliases: record?.aliases, totalEpisodes: record?.totalEpisodes }
}
export async function invokeData(method: string, args: unknown[], services: Services): Promise<unknown> {
  const { data, playback } = services
  switch (method) {
    case 'data.home': return data.home()
    case 'data.filters': return data.filters(type(args[0]))
    case 'data.channel': return data.channel(type(args[0]), query(args[1]), args[2] === undefined ? undefined : string(args[2], 2000))
    case 'data.detail': return data.detail(id(args[0]))
    case 'data.subject': return data.subject(id(args[0]))
    case 'data.person':
    case 'data.personWorks': {
      const who = person(args[0]), cursor = args[1] === undefined ? undefined : string(args[1], 8)
      try { return await (method === 'data.person' ? data.person(who) : data.personWorks(who, cursor)) }
      // "Not found" otherwise speaks of a title.
      catch (error) { throw error instanceof DataError && error.code === 'NOT_FOUND' ? new Error(extra.personNotFound) : error }
    }
    case 'data.related': return data.related(id(args[0]))
    case 'data.byIds': {
      if (!Array.isArray(args[0]) || args[0].length > 10000) return invalid()
      return data.byIds(args[0].map(id))
    }
    case 'data.libraryPage': {
      if (!Array.isArray(args[0]) || args[0].length > 10000 || (args[3] !== undefined && typeof args[3] !== 'boolean')) return invalid()
      const ids = args[0].map(id), cursor = args[1] === undefined ? undefined : string(args[1], 5)
      const request = args[2] === undefined ? undefined : string(args[2], 80)
      if (request !== undefined && !/^[\w-]{1,80}$/.test(request)) return invalid()
      const requests = services.libraryRequests ??= new Map<string, AbortController>()
      if (request === undefined) return data.libraryPage(ids, cursor, undefined, args[3] === true)
      if (requests.size >= 8 && !requests.has(request)) throw new DataError('RATE_LIMITED', 'Too many library requests')
      requests.get(request)?.abort()
      const controller = new AbortController()
      requests.set(request, controller)
      try { return await data.libraryPage(ids, cursor, controller.signal, args[3] === true) }
      finally { if (requests.get(request) === controller) requests.delete(request) }
    }
    case 'data.cancelLibrary': {
      const request = string(args[0], 80)
      if (!/^[\w-]{1,80}$/.test(request)) return invalid()
      services.libraryRequests?.get(request)?.abort()
      services.libraryRequests?.delete(request)
      return
    }
    case 'data.search': return data.search(string(args[0]))
    case 'data.titleHints': return data.titleHints(string(args[0]))
    case 'data.suggest': return data.suggest(string(args[0]))
    case 'data.hotSearches': return data.hotSearches()
    case 'data.availability': {
      const item = await data.subject(id(args[0]))
      return playback.availability(item, hints(data, item.id))
    }
    case 'data.playback':
    case 'data.retryPlayback':
    case 'data.playbackFrom': {
      const picked = method === 'data.playbackFrom'
      const episode = number(args[1]), quality = args[picked ? 3 : 2]
      if (quality !== undefined && !QUALITIES.includes(quality as Quality)) return invalid()
      const from = picked ? string(args[2], 40) : undefined
      const retryFailure = method === 'data.retryPlayback' && args[3] !== undefined
        ? args[3] === 'stall' || args[3] === 'probe' ? args[3] : invalid()
        : undefined
      if (from !== undefined && !/^[\w-]+$/.test(from)) return invalid()
      const item = await data.subject(id(args[0]))
      return playback.resolve(item, episode, quality as Quality | undefined, method === 'data.retryPlayback', hints(data, item.id), from, retryFailure)
    }
    case 'data.sources': {
      const episode = number(args[1])
      const item = await data.subject(id(args[0]))
      return playback.sources(item, episode, hints(data, item.id))
    }
    case 'playback.rules': {
      if (!services.alignment || !services.buffer || !services.budget) throw new DataError('UNAVAILABLE', 'Playback rules are unavailable')
      return { alignment: services.alignment, buffer: services.buffer, budget: services.budget }
    }
    case 'playback.prepareSwitch': {
      const workId = id(args[0]), episode = number(args[1])
      const input = args[2]
      if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid()
      const { quality, retry, failure, from } = input as Record<string, unknown>
      if (!QUALITIES.includes(quality as Quality) || (retry !== undefined && typeof retry !== 'boolean')) return invalid()
      if (failure !== undefined && (retry !== true || (failure !== 'probe' && failure !== 'stall'))) return invalid()
      if (from !== undefined && (typeof from !== 'string' || !/^[\w-]{1,40}$/.test(from) || retry)) return invalid()
      const item = await data.subject(workId)
      return playback.resolve(item, episode, quality as Quality, retry === true, hints(data, workId), from, failure, true)
    }
    case 'playback.acceptSwitch': {
      const selection = args[2]
      if (typeof selection !== 'number' || !Number.isSafeInteger(selection) || selection < 1) return invalid()
      return playback.acceptSwitch(id(args[0]), number(args[1]), selection)
    }
    case 'sources.observe': {
      const sourceKey = string(args[0], 40)
      if (!/^[\w-]+$/.test(sourceKey)) return invalid()
      const playSeconds = decimal(args[1]), stallSeconds = decimal(args[2])
      services.health?.updateLive(sourceKey, { playSeconds, stallSeconds })
      return
    }
    case 'sources.health': {
      const workId = args[0] === undefined ? undefined : id(args[0])
      if (!services.health) throw new DataError('UNAVAILABLE', 'Source health is unavailable')
      return services.health.snapshot(workId)
    }
    case 'playback.align': {
      const raw = args[0]
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalid()
      const input = raw as Record<string, unknown>
      if (input.capability !== 'frames' && input.capability !== 'no-frames') return invalid()
      const offsets = services.offsets, alignment = services.alignment
      if (!offsets || !alignment) throw new DataError('UNAVAILABLE', 'Alignment is unavailable')
      const workId = id(input.workId), episode = number(input.episode)
      const from = alignEndpoint(input.from), to = alignEndpoint(input.to)
      return align({
        workId, episode,
        position: decimal(input.position),
        from, to,
        history: services.health?.durationHistory(workId, episode, from.sourceKey, to.sourceKey) ?? { sourceSamples: [], workRatios: [] },
        capability: input.capability,
        samples: alignSamples(input.samples),
        elapsedMs: input.elapsedMs === undefined ? invalid() : decimal(input.elapsedMs),
      }, { offsets, config: alignment })
    }
    case 'user.get': return services.user().get()
    case 'user.recovery': return services.recovery?.() ?? invalid()
    case 'user.recover': {
      if (typeof args[0] !== 'boolean' || !services.recover) return invalid()
      const next = services.recover(args[0])
      services.changed()
      return next
    }
    case 'user.dispatch': {
      const next = services.user().dispatch(args[0] as StateAction)
      services.changed()
      return next
    }
    default: return invalid()
  }
}
export async function rpc<T>(action: () => Promise<T> | T, isPlayback = false): Promise<RpcResult<T>> {
  try { return { ok: true, value: await action() } }
  catch (error) {
    const safe = safeError(error, isPlayback)
    // The window only gets the generic text; the reason stays in the main-process log.
    if (safe.code !== 'INVALID_INPUT') console.info('[failure]', safe.code, error instanceof Error ? error.message : String(error))
    return { ok: false, error: safe }
  }
}
