import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** What the first bytes say the file is; the stored name carries no type. */
export function imageType(body: Buffer): string | undefined {
  if (body.length < 12) return undefined
  if (body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return 'image/jpeg'
  if (body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  const head = body.toString('latin1', 0, 12)
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return 'image/gif'
  if (head.startsWith('RIFF') && head.endsWith('WEBP')) return 'image/webp'
  if (head.slice(4) === 'ftypavif' || head.slice(4) === 'ftypavis') return 'image/avif'
  return undefined
}

/**
 * Artwork kept on disk between runs. Douban names an image by its own id (…/p2935853700.jpg),
 * so the bytes behind one address do not change, and the window cannot keep them itself: the
 * loopback address an image is shown from is new in every run. Without this every start
 * downloads every poster on screen again.
 *
 * A file is named by the hash of its upstream address and written whole or not at all. The
 * cache is optional throughout: a file that cannot be read or written means a download.
 */
export class ImageCache {
  private pendingBytes = 0
  private pruneTimer?: ReturnType<typeof setTimeout>
  private pruning?: Promise<void>
  private closed = false
  private readonly writes = new Set<Promise<void>>()
  constructor(private readonly directory: string, private readonly maxBytes = 200 * 1024 * 1024, private readonly maxImageBytes = 2 * 1024 * 1024) {}

  /** Whether an image of this size is kept. */
  accepts(bytes: number): boolean { return bytes > 0 && bytes <= this.maxImageBytes }
  private path(url: string) { return join(this.directory, createHash('sha256').update(url).digest('hex')) }

  async get(url: string): Promise<{ body: Buffer; type: string } | undefined> {
    const path = this.path(url)
    try {
      const body = await readFile(path)
      const type = imageType(body)
      if (!type) { await unlink(path); return undefined }
      // The modification time is the last time the image was shown: `prune` removes by it.
      const now = new Date()
      void utimes(path, now, now).catch(() => {})
      return { body, type }
    } catch { return undefined }
  }

  put(url: string, body: Buffer): Promise<void> {
    if (this.closed || !this.accepts(body.length) || !imageType(body)) return Promise.resolve()
    const work = this.write(url, body).finally(() => { this.writes.delete(work) })
    this.writes.add(work)
    return work
  }

  private schedulePrune() {
    if (this.pendingBytes < Math.min(this.maxBytes * 0.2, 8 * 1024 * 1024) || this.pruneTimer || this.closed) return
    this.pruneTimer = setTimeout(() => { this.pruneTimer = undefined; void this.prune() }, 1000)
    this.pruneTimer.unref?.()
  }

  private async write(url: string, body: Buffer): Promise<void> {
    const path = this.path(url)
    const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`
    try {
      await mkdir(this.directory, { recursive: true })
      await writeFile(temporary, body)
      await rename(temporary, path)
      this.pendingBytes += body.length
      this.schedulePrune()
    } catch { await unlink(temporary).catch(() => {}) }
  }

  /** Removes the images shown longest ago once the directory outgrows its limit, and unfinished writes. */
  async prune(): Promise<void> {
    clearTimeout(this.pruneTimer)
    this.pruneTimer = undefined
    if (this.pruning) return this.pruning
    this.pendingBytes = 0
    const work = this.pruneFiles().finally(() => { if (this.pruning === work) this.pruning = undefined; this.schedulePrune() })
    this.pruning = work
    return work
  }

  async close(): Promise<void> {
    this.closed = true
    clearTimeout(this.pruneTimer)
    this.pruneTimer = undefined
    await Promise.allSettled([...this.writes])
    await this.pruning
    await this.prune()
  }

  private async pruneFiles(): Promise<void> {
    let names: string[]
    try { names = await readdir(this.directory) } catch { return }
    const files: Array<{ path: string; bytes: number; usedAt: number }> = []
    for (const name of names) {
      const path = join(this.directory, name)
      try {
        const info = await stat(path)
        if (!info.isFile()) continue
        if (!/^[a-f0-9]{64}$/.test(name)) { if (name.endsWith('.tmp') && Date.now() - info.mtimeMs > 60000) await unlink(path); continue }
        files.push({ path, bytes: info.size, usedAt: info.mtimeMs })
      } catch { /* Removed meanwhile. */ }
    }
    let total = files.reduce((sum, file) => sum + file.bytes, 0)
    if (total <= this.maxBytes) return
    for (const file of files.sort((a, b) => a.usedAt - b.usedAt)) {
      if (total <= this.maxBytes * 0.8) break
      try { await unlink(file.path); total -= file.bytes } catch { /* Kept: counted again next time. */ }
    }
  }
}
