import type { UpdateResult } from '../shared/api'
import { extra } from '../copy.extra'
import { list, row } from './data/normalize'
import { getText, validatePublicUrl } from './playback/network'

export const RELEASE_PAGE = 'https://github.com/7788dev/PandaTv/releases'
const RELEASES_API = 'https://api.github.com/repos/7788dev/PandaTv/releases'
const PAGE_SIZE = 30
const installer = /^Panda-(\d{1,6}\.\d{1,6}\.\d{1,6})-Setup\.exe$/

export function versionParts(value: unknown): number[] {
  if (typeof value !== 'string' || !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(value)) throw new Error(extra.updateFailed)
  return value.split('.').map(Number)
}
export function updateResult(current: string, published: unknown): Extract<UpdateResult, { version: string }> {
  const a = versionParts(current), b = versionParts(published)
  const first = a.findIndex((part, i) => part !== b[i])
  return { status: first >= 0 && b[first] > a[first] ? 'available' : 'current', version: String(published) }
}
export async function checkUpdate(current: string, endpoint = process.env.PANDA_UPDATE_URL): Promise<UpdateResult> {
  const signal = AbortSignal.timeout(8000)
  try {
    if (endpoint) {
      const url = validatePublicUrl(endpoint)
      if (url.protocol !== 'https:') throw new Error()
      const { text } = await getText(url, { signal }, 16384)
      return updateResult(current, row(JSON.parse(text)).version)
    }
    let latest: string | undefined
    for (let page = 1; ; page++) {
      const { text } = await getText(`${RELEASES_API}?per_page=${PAGE_SIZE}&page=${page}`,
        { signal, headers: { Accept: 'application/vnd.github+json' } }, 2 * 1024 * 1024)
      const releases: unknown = JSON.parse(text)
      if (!Array.isArray(releases)) throw new Error()
      for (const value of releases) {
        const release = row(value)
        if (release.draft !== false || release.prerelease !== false) continue
        for (const entry of list(release.assets)) {
          const asset = row(entry)
          if (asset.state !== 'uploaded' || typeof asset.size !== 'number' || asset.size <= 0 || typeof asset.name !== 'string') continue
          const version = installer.exec(asset.name)?.[1]
          if (version && (!latest || updateResult(latest, version).status === 'available')) latest = version
        }
      }
      if (releases.length < PAGE_SIZE) break
    }
    if (!latest) return { status: 'unpublished' }
    const result = updateResult(current, latest)
    return { ...result, canOpenReleases: result.status === 'available' }
  } catch { throw new Error(extra.updateFailed) }
}
