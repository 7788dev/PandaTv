import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, readdir, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { ImageCache, imageType } from '../src/main/playback/image-cache'
import { MediaProxy } from '../src/main/playback/proxy'
import { openPublic } from '../src/main/playback/network'

vi.mock('../src/main/playback/network', async original => ({
  ...await original<typeof import('../src/main/playback/network')>(),
  openPublic: vi.fn(),
}))

const jpeg = (bytes = 2000, fill = 7) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(bytes - 4, fill)])
const POSTER = 'https://img3.doubanio.com/view/photo/m_ratio_poster/public/p2935853700.jpg'
/** What Douban's image host answers with. */
function answer(body: Buffer, headers: Record<string, string> = { 'content-type': 'image/jpeg', 'content-length': String(body.length) }, statusCode = 200) {
  vi.mocked(openPublic).mockImplementation(async raw => ({ response: Object.assign(Readable.from([body.subarray(0, 900), body.subarray(900)]), { statusCode, headers }) as never, url: new URL(String(raw)) }))
}
async function run(imageDir: string) {
  const proxy = new MediaProxy({ rules: { sources: [], blocked: [] } as never, imageDir })
  await proxy.start()
  return proxy
}
const files = async (directory: string) => (await readdir(directory).catch(() => [])).filter(name => /^[a-f0-9]{64}$/.test(name))

describe('artwork kept between runs', () => {
  it('recognises the image formats the proxy lets through and nothing else', () => {
    expect(imageType(jpeg())).toBe('image/jpeg')
    expect(imageType(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)]))).toBe('image/png')
    expect(imageType(Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 ', 'latin1'))).toBe('image/webp')
    expect(imageType(Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00', 'latin1'))).toBe('image/gif')
    expect(imageType(Buffer.from('\x00\x00\x00\x1cftypavif\x00\x00', 'latin1'))).toBe('image/avif')
    expect(imageType(Buffer.from('<!doctype html><html></html>'))).toBeUndefined()
    expect(imageType(Buffer.from([0xff, 0xd8]))).toBeUndefined()
  })

  it('downloads a poster once: a later run shows it from disk without asking Douban', async () => {
    const imageDir = await mkdtemp(join(tmpdir(), 'panda-images-'))
    const body = jpeg()
    answer(body)
    const first = await run(imageDir)
    const shown = await fetch(first.registerImage(POSTER))
    expect(Buffer.from(await shown.arrayBuffer()).equals(body)).toBe(true)
    await vi.waitFor(async () => expect(await files(imageDir)).toHaveLength(1))
    await first.close()
    expect(openPublic).toHaveBeenCalledTimes(1)

    vi.mocked(openPublic).mockReset().mockRejectedValue(new Error('offline'))
    const second = await run(imageDir)
    const address = second.registerImage(POSTER)
    const again = await fetch(address)
    expect(again.status).toBe(200)
    expect(again.headers.get('content-type')).toBe('image/jpeg')
    expect(again.headers.get('content-length')).toBe(String(body.length))
    expect(Buffer.from(await again.arrayBuffer()).equals(body)).toBe(true)
    expect((await fetch(address, { method: 'HEAD' })).headers.get('content-length')).toBe(String(body.length))
    expect(openPublic).not.toHaveBeenCalled()
    // Another image is still a download, and its failure is still a failure.
    expect((await fetch(second.registerImage(POSTER.replace('p2935853700', 'p1')))).status).toBe(502)
    await second.close()
  })

  it('keeps nothing that is not a complete image', async () => {
    const imageDir = await mkdtemp(join(tmpdir(), 'panda-images-'))
    const proxy = await run(imageDir)
    // Cut short: fewer bytes than the answer declared.
    answer(jpeg(), { 'content-type': 'image/jpeg', 'content-length': '5000' })
    await fetch(proxy.registerImage(POSTER)).then(response => response.arrayBuffer()).catch(() => {})
    // Declared as an image, but it is not one.
    answer(Buffer.from('<html>blocked</html>'.padEnd(2000)), { 'content-type': 'image/jpeg' })
    await fetch(proxy.registerImage(POSTER.replace('p2935853700', 'p2'))).then(response => response.arrayBuffer())
    // An error answer.
    answer(jpeg(), { 'content-type': 'image/jpeg' }, 404)
    expect((await fetch(proxy.registerImage(POSTER.replace('p2935853700', 'p3')))).status).toBe(404)
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(await files(imageDir)).toHaveLength(0)
    await proxy.close()
  })

  it('asks again for a poster whose answer broke off, and gives the window a whole image or none', async () => {
    const imageDir = await mkdtemp(join(tmpdir(), 'panda-images-'))
    const proxy = await run(imageDir)
    const body = jpeg()
    const reply = (part: Buffer, raw: string | URL) => ({ response: Object.assign(Readable.from([part]), { statusCode: 200, headers: { 'content-type': 'image/jpeg', 'content-length': String(body.length) } }) as never, url: new URL(String(raw)) })
    // Half an image, then the whole one.
    vi.mocked(openPublic).mockReset().mockImplementationOnce(async raw => reply(body.subarray(0, 700), raw)).mockImplementationOnce(async raw => reply(body, raw))
    const shown = await fetch(proxy.registerImage(POSTER))
    expect(shown.status).toBe(200)
    expect(Buffer.from(await shown.arrayBuffer()).equals(body)).toBe(true)
    expect(openPublic).toHaveBeenCalledTimes(2)
    // No connection, then the image.
    vi.mocked(openPublic).mockReset().mockRejectedValueOnce(new Error('网络请求失败或超时')).mockImplementationOnce(async raw => reply(body, raw))
    expect((await fetch(proxy.registerImage(POSTER.replace('p2935853700', 'p4')))).status).toBe(200)
    // Broken off every time: an error, not a partial picture, after three requests and no more.
    vi.mocked(openPublic).mockReset().mockImplementation(async raw => reply(body.subarray(0, 700), raw))
    const failed = await fetch(proxy.registerImage(POSTER.replace('p2935853700', 'p5')))
    expect(failed.status).toBe(502)
    expect(openPublic).toHaveBeenCalledTimes(3)
    // Each request allows more time to connect than the one before.
    expect(vi.mocked(openPublic).mock.calls.map(call => call[1]?.handshakeMs)).toEqual([1500, 2500, 5000])
    // An answer that is final is not asked for again.
    vi.mocked(openPublic).mockReset().mockImplementation(async raw => ({ response: Object.assign(Readable.from([Buffer.from('gone')]), { statusCode: 404, headers: {} }) as never, url: new URL(String(raw)) }))
    expect((await fetch(proxy.registerImage(POSTER.replace('p2935853700', 'p6')))).status).toBe(404)
    expect(openPublic).toHaveBeenCalledTimes(1)
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(await files(imageDir)).toHaveLength(2)
    await proxy.close()
  })

  it('leaves out images above the size it keeps, and a file that is no image is dropped when read', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'panda-images-'))
    const cache = new ImageCache(directory, 10000, 3000)
    await cache.put('a', jpeg(3001))
    expect(await cache.get('a')).toBeUndefined()
    await cache.put('b', jpeg(3000))
    expect((await cache.get('b'))?.type).toBe('image/jpeg')
    const [name] = await files(directory)
    await writeFile(join(directory, name!), 'not an image any more')
    expect(await cache.get('b')).toBeUndefined()
    expect(await files(directory)).toHaveLength(0)
  })

  it('removes the images shown longest ago once the directory outgrows its limit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'panda-images-'))
    const cache = new ImageCache(directory, 10000, 3000)
    const names: string[] = []
    for (let i = 0; i < 5; i++) {
      await cache.put(`image-${i}`, jpeg(3000, i))
      const added = (await files(directory)).find(name => !names.includes(name))!
      names.push(added)
      const at = new Date(Date.now() - (10 - i) * 3600000)
      await utimes(join(directory, added), at, at)
    }
    await writeFile(join(directory, 'abandoned.tmp'), 'x')
    const old = new Date(Date.now() - 3600000)
    await utimes(join(directory, 'abandoned.tmp'), old, old)
    // image-0 is shown again, so it is the newest now.
    expect(await cache.get('image-0')).toBeDefined()
    await new Promise(resolve => setTimeout(resolve, 50))
    await cache.prune()
    // 15000 bytes against a limit of 10000: down to 80 % of it, oldest first.
    expect((await readdir(directory)).sort()).toEqual([names[0], names[4]].sort())
    expect(await cache.get('image-4')).toBeDefined()
    expect(await cache.get('image-1')).toBeUndefined()
  })
})
