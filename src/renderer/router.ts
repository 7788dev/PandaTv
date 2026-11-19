import { useSyncExternalStore } from 'react'

type NavigationState = { pandaIndex: number }
let index = typeof history.state?.pandaIndex === 'number' ? history.state.pandaIndex : 0
if (!history.state || typeof history.state.pandaIndex !== 'number') {
  history.replaceState({ ...history.state, pandaIndex: index } satisfies NavigationState, '')
}

const listeners = new Set<() => void>()
function changed() {
  if (typeof history.state?.pandaIndex !== 'number') {
    index += 1
    history.replaceState({ ...history.state, pandaIndex: index }, '')
  } else index = history.state.pandaIndex
  listeners.forEach(listener => listener())
}
addEventListener('hashchange', changed)
addEventListener('popstate', changed)

export function go(path: string, { replace = false }: { replace?: boolean } = {}) {
  const hash = `#${path.startsWith('/') ? path : `/${path}`}`
  if (replace) {
    history.replaceState({ ...history.state, pandaIndex: index }, '', hash)
    changed()
  } else location.hash = hash
}

export function back(fallback = '/') {
  if (index > 0) history.back()
  else go(fallback, { replace: true })
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useRoute() {
  const hash = useSyncExternalStore(subscribe, () => `${index}:${location.hash || '#/'}`)
  const route = hash.slice(hash.indexOf(':') + 1).slice(1)
  const q = route.indexOf('?')
  const path = q < 0 ? route : route.slice(0, q)
  return { path, query: new URLSearchParams(q < 0 ? '' : route.slice(q + 1)), key: hash, index }
}
