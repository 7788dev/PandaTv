import type { ChannelQuery, MediaType, Quality } from '../../design/contract/types'
import { QUALITIES } from '../../design/contract/constants'
import { t } from '../../design/contract/copy'
import type { RpcResult } from '../shared/rpc'
import type { StateAction } from '../shared/api'
import { extra } from '../copy.extra'
import { DataError } from './data/http'
import type { DoubanDataSource } from './data/douban'
import type { PlaybackService, WorkHints } from './playback/service'
import { UserStore, validId } from './state'

const types = ['tv', 'movie', 'variety', 'anime', 'doc']
export interface Services {
  data: DoubanDataSource
  playback: PlaybackService
  user: () => UserStore
  changed: () => void
}
export function safeError(error: unknown, playback = false): { code: string; message: string } {
  if (error instanceof DataError) {
    const messages = { INVALID_INPUT: extra.invalidInput, NOT_FOUND: extra.notFound, NETWORK: t.state.offline, TIMEOUT: extra.timeout, RATE_LIMITED: extra.rateLimited, UPSTREAM: extra.unavailable, INVALID_RESPONSE: extra.unavailable, UNAVAILABLE: extra.unavailable, STORAGE: extra.saveError }
    return { code: error.code, message: messages[error.code] }
  }
  const message = error instanceof Error ? error.message : ''
  if (message === 'INVALID_INPUT') return { code: 'INVALID_INPUT', message: extra.invalidInput }
  if (message === 'STATE_CORRUPT') return { code: 'STORAGE', message: extra.stateCorrupt }
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
    case 'data.search': return data.search(string(args[0]))
    case 'data.suggest': return data.suggest(string(args[0]))
    case 'data.hotSearches': return data.hotSearches()
    case 'data.availability': {
      const item = await data.detail(id(args[0]))
      return playback.availability(item, hints(data, item.id))
    }
    case 'data.playback':
    case 'data.retryPlayback':
    case 'data.playbackFrom': {
      const picked = method === 'data.playbackFrom'
      const episode = number(args[1]), quality = args[picked ? 3 : 2]
      if (quality !== undefined && !QUALITIES.includes(quality as Quality)) return invalid()
      const from = picked ? string(args[2], 40) : undefined
      if (from !== undefined && !/^[\w-]+$/.test(from)) return invalid()
      const item = await data.detail(id(args[0]))
      return playback.resolve(item, episode, quality as Quality | undefined, method === 'data.retryPlayback', hints(data, item.id), from)
    }
    case 'data.sources': {
      const episode = number(args[1])
      const item = await data.detail(id(args[0]))
      return playback.sources(item, episode, hints(data, item.id))
    }
    case 'user.get': return services.user().get()
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
