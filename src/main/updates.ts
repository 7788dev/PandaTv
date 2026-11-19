import type { UpdateResult } from '../shared/api'
import { extra } from '../copy.extra'
import { getText, validatePublicUrl } from './playback/network'

export function versionParts(value: unknown): number[] {
  if (typeof value !== 'string' || !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(value)) throw new Error(extra.updateFailed)
  return value.split('.').map(Number)
}
export function updateResult(current: string, published: unknown): UpdateResult {
  const a = versionParts(current), b = versionParts(published)
  const first = a.findIndex((part, i) => part !== b[i])
  return { status: first >= 0 && b[first] > a[first] ? 'available' : 'current', version: String(published) }
}
export async function checkUpdate(current: string, endpoint = process.env.PANDA_UPDATE_URL): Promise<UpdateResult> {
  if (!endpoint) throw new Error(extra.updateUnavailable)
  const url = validatePublicUrl(endpoint)
  if (url.protocol !== 'https:') throw new Error(extra.updateFailed)
  try {
    const { text } = await getText(url, { signal: AbortSignal.timeout(8000) }, 16384)
    const response: unknown = JSON.parse(text)
    if (!response || typeof response !== 'object' || !('version' in response)) throw new Error()
    return updateResult(current, response.version)
  } catch { throw new Error(extra.updateFailed) }
}
