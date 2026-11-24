import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DEFAULT_SETTINGS, QUALITIES, SPEEDS } from '../contract/constants'
import type { HistoryEntry, Settings, UserState } from '../contract/types'
import type { StateAction, StateRecovery } from '../shared/api'

const idPattern = /^db-\d{1,16}$/
export function validId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !idPattern.test(value)) throw new Error('INVALID_INPUT')
}
const finite = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
export function validateHistory(value: unknown): HistoryEntry {
  if (!value || typeof value !== 'object') throw new Error('INVALID_INPUT')
  const e = value as HistoryEntry
  validId(e.id)
  if (!Number.isInteger(e.episode) || !finite(e.episode, 1, 100000) || !finite(e.duration, 0, 604800) || !finite(e.position, 0, e.duration) || !finite(e.at, 0, Date.now() + 60_000)) throw new Error('INVALID_INPUT')
  return { id: e.id, episode: e.episode, position: e.position, duration: e.duration, at: e.at }
}
function settingsPatch(value: unknown): Partial<Settings> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_INPUT')
  const result: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(value)) {
    const valid = ['autoNext', 'skipIntro', 'muted'].includes(key) ? typeof field === 'boolean'
      : key === 'volume' ? finite(field, 0, 1)
      : key === 'speed' ? SPEEDS.includes(field as Settings['speed'])
      : key === 'quality' ? QUALITIES.includes(field as Settings['quality']) : false
    if (!valid) throw new Error('INVALID_INPUT')
    result[key] = field
  }
  return result
}
function loadSettings(value: unknown): Partial<Settings> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result: Partial<Settings> = {}
  for (const [key, field] of Object.entries(value)) {
    try { Object.assign(result, settingsPatch({ [key]: field })) } catch { /* Unknown or invalid values keep the default. */ }
  }
  return result
}
export function initialUserState(): UserState { return { favorites: [], history: [], searches: [], settings: { ...DEFAULT_SETTINGS } } }
function parseState(text: string): UserState {
  const saved = JSON.parse(text) as UserState
  if (!saved || !Array.isArray(saved.favorites) || !Array.isArray(saved.history) || !Array.isArray(saved.searches)) throw new Error('STATE_CORRUPT')
  saved.favorites.forEach(validId)
  // A malformed row or a setting from a newer/older build must not lock the viewer out of
  // valid favourites and settings. Drop only the bad rows; whole-file corruption still fails.
  const history = saved.history.flatMap(entry => { try { return [validateHistory(entry)] } catch { return [] } }).slice(0, 10000)
  const settings = loadSettings(saved.settings)
  return { favorites: [...new Set(saved.favorites)].slice(0, 10000), history, searches: saved.searches.filter(q => typeof q === 'string' && q.length <= 200).slice(0, 8), settings: { ...DEFAULT_SETTINGS, ...settings } }
}
function atomicWrite(path: string, bytes: string | Buffer) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx', flush: true })
    renameSync(temporary, path)
  } finally { if (existsSync(temporary)) unlinkSync(temporary) }
}
export function reduceUser(state: UserState, action: StateAction): UserState {
  if (!action || typeof action !== 'object') throw new Error('INVALID_INPUT')
  switch (action.type) {
    case 'favorite': {
      validId(action.id)
      return { ...state, favorites: state.favorites.includes(action.id) ? state.favorites.filter(id => id !== action.id) : [action.id, ...state.favorites].slice(0, 10000) }
    }
    case 'history:record':
    case 'history:restore': {
      const entry = validateHistory(action.entry)
      return { ...state, history: [entry, ...state.history.filter(h => h.id !== entry.id)].sort((a, b) => b.at - a.at).slice(0, 10000) }
    }
    case 'history:remove': validId(action.id); return { ...state, history: state.history.filter(h => h.id !== action.id) }
    case 'history:clear': return { ...state, history: [] }
    case 'search:add': {
      if (typeof action.query !== 'string' || action.query.length > 200) throw new Error('INVALID_INPUT')
      const query = action.query.trim()
      return query ? { ...state, searches: [query, ...state.searches.filter(q => q !== query)].slice(0, 8) } : state
    }
    case 'search:clear': return { ...state, searches: [] }
    case 'settings': return { ...state, settings: { ...state.settings, ...settingsPatch(action.patch) } }
    default: throw new Error('INVALID_INPUT')
  }
}
export class UserStore {
  private state = initialUserState()
  constructor(private readonly path: string) {
    if (!existsSync(path)) return
    try { this.state = parseState(readFileSync(path, 'utf8')) }
    catch (cause) { throw new Error('STATE_CORRUPT', { cause }) }
  }
  static recovery(path: string): StateRecovery {
    let needed = false, canRestore = false
    if (existsSync(path)) { try { parseState(readFileSync(path, 'utf8')) } catch { needed = true } }
    try { parseState(readFileSync(`${path}.bak`, 'utf8')); canRestore = true } catch { /* No usable backup. */ }
    return { needed, canRestore }
  }
  static recover(path: string, restoreBackup: boolean): UserStore {
    if (!this.recovery(path).needed) throw new Error('INVALID_INPUT')
    const next = restoreBackup ? parseState(readFileSync(`${path}.bak`, 'utf8')) : initialUserState()
    try {
      // Retain the exact original bytes before an explicit restore or reset.
      atomicWrite(`${path}.corrupt-${randomUUID()}`, readFileSync(path))
      if (existsSync(`${path}.bak`)) atomicWrite(`${path}.bak.recovery-${randomUUID()}`, readFileSync(`${path}.bak`))
      atomicWrite(path, JSON.stringify(next))
    } catch (cause) { throw new Error('STATE_WRITE_FAILED', { cause }) }
    return new UserStore(path)
  }
  static recoveryExport(path: string): string {
    if (!this.recovery(path).needed) throw new Error('INVALID_INPUT')
    return JSON.stringify({ format: 'panda-state-recovery-v1', at: new Date().toISOString(), original: readFileSync(path).toString('base64'), backup: existsSync(`${path}.bak`) ? readFileSync(`${path}.bak`).toString('base64') : undefined }, null, 2)
  }
  get(): UserState { return structuredClone(this.state) }
  dispatch(action: StateAction): UserState {
    const next = reduceUser(this.state, action)
    try {
      atomicWrite(`${this.path}.bak`, JSON.stringify(existsSync(this.path) ? this.state : next))
      atomicWrite(this.path, JSON.stringify(next))
    } catch (cause) { throw new Error('STATE_WRITE_FAILED', { cause }) }
    this.state = next
    return this.get()
  }
}
