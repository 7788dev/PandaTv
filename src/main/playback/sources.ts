import { existsSync, readFileSync } from 'node:fs'
import bundled from '../../../resources/play-sources.json'
import { validatePublicUrl } from './network'

/** `adPaths`: path prefixes the source reserves for ads. `fingerprints`: segment durations of captured ad blocks. */
export interface PlaySource { key: string; name: string; api: string; enabled: boolean; priority: number; adPaths: string[]; fingerprints: number[][]; excludedRecordIds?: string[] }
/** `foreignBlockMaxSeconds`: longest out-of-directory block treated as an insert; 0 turns that evidence off. */
export interface SourceRules { version: number; verifiedAt: string; maxDropRatio: number; foreignBlockMaxSeconds: number; sources: PlaySource[] }

export function validateSourceRules(raw: unknown): SourceRules {
  if (!raw || typeof raw !== 'object') throw new Error('播放源配置无效')
  const data = raw as SourceRules
  if (!Number.isInteger(data.version) || data.version < 1 || !Array.isArray(data.sources) || !Number.isFinite(Date.parse(data.verifiedAt)) || !Number.isFinite(data.maxDropRatio) || data.maxDropRatio <= 0 || data.maxDropRatio > 0.15 || !Number.isFinite(data.foreignBlockMaxSeconds) || data.foreignBlockMaxSeconds < 0 || data.foreignBlockMaxSeconds > 90) throw new Error('播放源规则版本或安全限制无效')
  if (data.sources.length > 30) throw new Error('播放源数量过多')
  const keys = new Set<string>()
  for (const source of data.sources) {
    if (!/^[a-z0-9-]{1,32}$/.test(source.key) || keys.has(source.key) || typeof source.name !== 'string' || source.name.length > 40 || typeof source.enabled !== 'boolean' || !Number.isFinite(source.priority)) throw new Error('播放源身份无效')
    keys.add(source.key); validatePublicUrl(source.api)
    if (source.excludedRecordIds !== undefined && (!Array.isArray(source.excludedRecordIds) || source.excludedRecordIds.length > 2048 ||
      source.excludedRecordIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)))) throw new Error('片源排除记录无效')
    // A prefix must name whole directory levels; "/" or a bare word would match programme segments.
    if (!Array.isArray(source.adPaths) || source.adPaths.some(path => typeof path !== 'string' || !/^\/(?:[A-Za-z0-9_-]+\/){2,6}$/.test(path))) throw new Error('广告路径规则无效')
    if (!Array.isArray(source.fingerprints) || source.fingerprints.some(fp => !Array.isArray(fp) || fp.length < 4 || fp.length > 16 || fp.some(n => !Number.isFinite(n) || n <= 0 || n > 20))) throw new Error('广告时长指纹无效')
  }
  return structuredClone(data)
}

export function loadSourceRules(path = process.env.PANDA_SOURCE_CONFIG): SourceRules {
  return validateSourceRules(path ? JSON.parse(readFileSync(path, 'utf8')) : bundled)
}

export const SOURCE_RULES_FILE = 'play-sources.json'

/**
 * Rules for a running install. Sources and ad fingerprints change faster than releases, so a
 * validated file in the user data directory replaces the bundled rules without a reinstall.
 * It is used only when it is valid and at least as new as the bundled version; otherwise the
 * bundled rules apply and the reason is reported. Rules are never fetched from the network:
 * they decide which hosts are contacted and which segments are removed.
 */
export function resolveSourceRules(overridePath: string | undefined, report: (message: string) => void = () => {}): SourceRules {
  if (process.env.PANDA_SOURCE_CONFIG) return loadSourceRules()
  const shipped = loadSourceRules(undefined)
  if (!overridePath || !existsSync(overridePath)) return shipped
  try {
    const custom = validateSourceRules(JSON.parse(readFileSync(overridePath, 'utf8').replace(/^\uFEFF/, '')))
    if (custom.version < shipped.version) { report(`rules override v${custom.version} is older than bundled v${shipped.version}; ignored`); return shipped }
    report(`rules override v${custom.version} in use`)
    return custom
  } catch (error) {
    report(`rules override rejected: ${error instanceof Error ? error.message : String(error)}`)
    return shipped
  }
}
