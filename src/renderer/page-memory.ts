import type { MediaItem, Page } from '../contract/types'
import type { LibraryFailure } from '../shared/api'

export type LibraryMemory = { ids: string; items: MediaItem[]; failures: LibraryFailure[]; cursor?: string; more: boolean; settled: boolean }
type Memory = { top: number; href?: string; pages?: Page<MediaItem>[]; library?: LibraryMemory; rebuild?: boolean }

export function pageMemoryKey(path: string, query = new URLSearchParams()) {
  const sorted = new URLSearchParams(query)
  sorted.sort()
  return path + (sorted.size ? `?${sorted}` : '')
}

/** Content and its departure anchor share one bounded lifetime. Evicted pages start afresh. */
class PageMemory {
  private entries = new Map<string, Memory>()
  private entry(key: string) {
    const value = this.entries.get(key) ?? { top: 0 }
    this.entries.delete(key)
    this.entries.set(key, value)
    return value
  }
  get(key: string): Memory | undefined {
    const value = this.entries.get(key)
    if (value) { this.entries.delete(key); this.entries.set(key, value) }
    return value
  }
  savePosition(key: string, top: number, href?: string) {
    const value = this.entry(key)
    if (!value.rebuild) { value.top = top; value.href = href }
    this.trim()
  }
  saveScroll(key: string, top: number) {
    const value = this.entry(key)
    if (!value.rebuild) value.top = top
    this.trim()
  }
  savePages(key: string, pages: Page<MediaItem>[]) {
    const size = pages.reduce((sum, page) => sum + page.items.length, 0)
    // An empty answer must be read again on return, including after a filter request retry.
    if (!size && !pages.at(-1)?.next) { this.entries.delete(key); return }
    const value = this.entry(key)
    if (size > 600) { value.pages = undefined; value.top = 0; value.href = undefined; value.rebuild = true }
    else { value.pages = pages; value.rebuild = false }
    this.trim()
  }
  saveLibrary(key: string, library: LibraryMemory) {
    const value = this.entry(key)
    if (library.items.length > 600) { value.library = undefined; value.top = 0; value.href = undefined; value.rebuild = true }
    else { value.library = library; value.rebuild = false }
    this.trim()
  }
  reset(key: string) { this.entries.delete(key) }
  private trim() {
    let cards = [...this.entries.values()].reduce((sum, value) => sum + (value.pages?.reduce((n, page) => n + page.items.length, 0) ?? 0) + (value.library?.items.length ?? 0), 0)
    while (this.entries.size > 12 || cards > 2400) {
      const oldest = this.entries.keys().next().value!
      cards -= this.entries.get(oldest)?.pages?.reduce((n, page) => n + page.items.length, 0) ?? 0
      cards -= this.entries.get(oldest)?.library?.items.length ?? 0
      this.entries.delete(oldest)
    }
  }
}

export const pageMemory = new PageMemory()
