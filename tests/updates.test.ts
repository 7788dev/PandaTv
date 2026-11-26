import { afterEach, expect, it, vi } from 'vitest'
import { extra } from '../src/copy.extra'
import * as network from '../src/main/playback/network'
import { checkUpdate } from '../src/main/updates'

const reply = (value: unknown) => ({ text: JSON.stringify(value), url: new URL('https://api.github.com') })
const asset = (name: string, state = 'uploaded', size = 100) => ({ name, state, size })
const release = (...assets: ReturnType<typeof asset>[]) => ({ draft: false, prerelease: false, assets })
afterEach(() => { vi.restoreAllMocks() })

it('looks across pages for the highest uploaded stable Windows installer', async () => {
  const irrelevant = release(asset('Panda-TV-50.0.0.apk'), asset('Panda-7.0.0-Setup.exe', 'open'), asset('Panda-6.0.0-Setup.exe', 'uploaded', 0))
  const first = [...Array(27).fill(irrelevant), { ...release(asset('Panda-9.0.0-Setup.exe')), draft: true },
    { ...release(asset('Panda-8.0.0-Setup.exe')), prerelease: true }, release(asset('Panda-1.2.9-Setup.exe'))]
  const read = vi.spyOn(network, 'getText').mockResolvedValueOnce(reply(first)).mockResolvedValueOnce(reply([release(asset('Panda-1.10.0-Setup.exe'))]))
  await expect(checkUpdate('1.4.0', '')).resolves.toEqual({ status: 'available', version: '1.10.0', canOpenReleases: true })
  expect(String(read.mock.calls[1]?.[0])).toMatch(/page=2$/)
})

it('distinguishes a current version, no Windows releases and a failed response', async () => {
  vi.spyOn(network, 'getText').mockResolvedValueOnce(reply([release(asset('Panda-1.1.4-Setup.exe'))]))
    .mockResolvedValueOnce(reply([])).mockResolvedValueOnce(reply({ message: 'unavailable' }))
  await expect(checkUpdate('1.1.4', '')).resolves.toMatchObject({ status: 'current', version: '1.1.4' })
  await expect(checkUpdate('1.1.4', '')).resolves.toEqual({ status: 'unpublished' })
  await expect(checkUpdate('1.1.4', '')).rejects.toThrow(extra.updateFailed)
})

it('keeps custom HTTPS version manifests independent from GitHub releases', async () => {
  const read = vi.spyOn(network, 'getText').mockResolvedValue(reply({ version: '2.0.0' }))
  await expect(checkUpdate('1.1.4', 'https://updates.example.org/version')).resolves.toEqual({ status: 'available', version: '2.0.0' })
  await expect(checkUpdate('1.1.4', 'http://updates.example.org/version')).rejects.toThrow(extra.updateFailed)
  expect(read).toHaveBeenCalledTimes(1)
})
