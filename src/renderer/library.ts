import { useEffect, useMemo, useRef, useState } from 'react'
import type { MediaItem } from '../contract/types'
import type { LibraryFailure, LibraryPage } from '../shared/api'
import { pageMemory } from './page-memory'

/** Read cached rows first, then enrich small groups; only requested pages issue network reads. */
export function usePagedLibrary(ids: string[], cacheKey: string) {
  const identity = ids.join(',')
  const saved = useMemo(() => {
    const memory = pageMemory.get(cacheKey)?.library
    if (memory && memory.ids !== identity) { pageMemory.reset(cacheKey); return undefined }
    return memory
  }, [identity, cacheKey])
  const [items, setItems] = useState<MediaItem[]>(saved?.items ?? [])
  const [failures, setFailures] = useState<LibraryFailure[]>(saved?.failures ?? [])
  const [loading, setLoading] = useState(Boolean(ids.length && !saved?.settled))
  const [loaded, setLoaded] = useState(Boolean(saved) || !ids.length)
  const [error, setError] = useState<unknown>(null)
  const [hasMore, setHasMore] = useState(saved?.more ?? false)
  const control = useRef<{ more: () => void; retry: (id?: string) => void }>({ more: () => {}, retry: () => {} })

  useEffect(() => {
    let active = true, busy = false, cursor = saved?.cursor, more = saved?.more ?? false, settled = saved?.settled ?? false
    const request = crypto.randomUUID()
    const records = new Map<string, MediaItem>(saved?.items.map(item => [item.id, item]))
    const failed = new Map<string, LibraryFailure>(saved?.failures.map(failure => [failure.id, failure]))
    const publish = () => {
      if (!active) return
      const items = ids.flatMap(id => records.get(id) ?? [])
      const failures = ids.flatMap(id => failed.get(id) ?? [])
      pageMemory.saveLibrary(cacheKey, { ids: identity, items, failures, cursor, more, settled })
      setItems(items)
      setFailures(failures)
    }
    const merge = (page: LibraryPage) => {
      for (const item of page.items) { records.set(item.id, item); failed.delete(item.id) }
      for (const failure of page.failures) failed.set(failure.id, failure)
      publish()
    }
    const enrich = async (pending: string[]) => {
      for (let at = 0; active && at < pending.length; at += 6) {
        const group = pending.slice(at, at + 6)
        try { merge(await window.panda.data.libraryPage(group, undefined, request)) }
        catch (problem) {
          if (!active) return
          for (const id of group) failed.set(id, { id, code: String((problem as { code?: string }).code ?? 'UNAVAILABLE') })
          publish()
        }
      }
    }
    const run = async (retryIds?: string[]) => {
      if (!active || busy) return
      busy = true; setLoading(true); setError(null)
      try {
        if (retryIds) await enrich(retryIds)
        else {
          settled = false
          const cached = await window.panda.data.libraryPage(ids, cursor, request, true)
          if (!active) return
          merge(cached)
          setLoaded(true)
          await enrich(cached.pending)
          if (!active) return
          cursor = cached.next ?? undefined
          more = Boolean(cached.next); settled = true
          setHasMore(more); publish()
        }
      } catch (problem) { if (active) setError(problem) }
      finally { busy = false; if (active) { setLoaded(true); setLoading(false) } }
    }
    control.current = { more: () => { void run() }, retry: id => { void run(id ? [id] : [...failed.keys()]) } }
    if (ids.length && !saved?.settled) void run()
    return () => { active = false; void window.panda.data.cancelLibrary(request).catch(() => {}) }
  }, [identity, cacheKey])
  return { items, failures, loading, loaded, error, hasMore, more: () => control.current.more(), retry: (id?: string) => control.current.retry(id) }
}
