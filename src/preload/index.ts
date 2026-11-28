import { contextBridge, ipcRenderer } from 'electron'
import type { PandaBridge } from '../shared/api'
import { unwrap } from '../shared/rpc'

async function call<T>(method: string, ...args: unknown[]): Promise<T> { return unwrap(await ipcRenderer.invoke('panda:invoke', method, args)) }
function subscribe<T>(channel: string, callback: (value: T) => void): () => void {
  const listener = (_: Electron.IpcRendererEvent, value: T) => callback(value)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}
const bridge: PandaBridge = {
  data: {
    home: () => call('data.home'), filters: type => call('data.filters', type),
    channel: (type, query, cursor) => call('data.channel', type, query, cursor),
    detail: id => call('data.detail', id), related: id => call('data.related', id),
    subject: id => call('data.subject', id), libraryPage: (ids, cursor, request, cachedOnly) => call('data.libraryPage', ids, cursor, request, cachedOnly),
    cancelLibrary: request => call('data.cancelLibrary', request),
    person: id => call('data.person', id), personWorks: (id, cursor) => call('data.personWorks', id, cursor),
    byIds: ids => call('data.byIds', ids), search: q => call('data.search', q),
    suggest: q => call('data.suggest', q), hotSearches: () => call('data.hotSearches'),
    titleHints: q => call('data.titleHints', q),
    playback: (id, episode, quality) => call('data.playback', id, episode, quality),
    retryPlayback: (id, episode, quality, failure) => call('data.retryPlayback', id, episode, quality, failure),
    availability: (id, preferredEpisode) => call('data.availability', id, preferredEpisode),
    sources: (id, episode) => call('data.sources', id, episode),
    playbackRules: () => call('playback.rules'),
    prepareSwitch: (id, episode, options) => call('playback.prepareSwitch', id, episode, options),
    acceptSwitch: (id, episode, selectionId) => call('playback.acceptSwitch', id, episode, selectionId),
    playbackFrom: (id, episode, source, quality) => call('data.playbackFrom', id, episode, source, quality),
    align: input => call('playback.align', input),
    onHome: callback => subscribe('panda:home', callback),
    onCatalogueUpdate: callback => subscribe('panda:catalogue', callback)
  },
  sources: {
    health: workId => call('sources.health', workId),
    observe: (sourceKey, playSeconds, stallSeconds) => call('sources.observe', sourceKey, playSeconds, stallSeconds),
  },
  user: {
    get: () => call('user.get'), dispatch: action => call('user.dispatch', action), subscribe: callback => subscribe('panda:user', callback),
    recovery: () => call('user.recovery'), recover: restoreBackup => call('user.recover', restoreBackup), exportRecovery: () => call('user.exportRecovery')
  },
  window: { minimize: () => call('window.minimize'), maximize: () => call('window.maximize'), close: () => call('window.close'), fullscreen: value => call('window.fullscreen', value), getState: () => call('window.state'), subscribe: callback => subscribe('panda:window', callback) },
  app: {
    info: () => call('app.info'), checkUpdate: () => call('app.checkUpdate'), openReleases: () => call('app.openReleases'),
    subscribe: callback => subscribe('panda:notice', callback),
    onBeforeClose: callback => { beforeClose.add(callback); return () => { beforeClose.delete(callback) } }
  }
}
const beforeClose = new Set<() => void | Promise<void>>()
ipcRenderer.on('panda:closing', async (_event, nonce: string) => {
  await Promise.allSettled([...beforeClose].map(callback => Promise.resolve().then(callback)))
  ipcRenderer.send('panda:close-ready', nonce)
})
contextBridge.exposeInMainWorld('panda', bridge)
