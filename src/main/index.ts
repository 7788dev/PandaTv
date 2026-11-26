import { app, BrowserWindow, dialog, ipcMain, screen, session, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { t } from '../contract/copy'
import { extra } from '../copy.extra'
import { DoubanDataSource } from './data/douban'
import { createTransport } from './data/transport'
import { MediaProxy } from './playback/proxy'
import { PlaybackService } from './playback/service'
import { resolveSourceRules, SOURCE_RULES_FILE } from './playback/sources'
import { loadRuleCalibration } from './health/config'
import { SourceHealthStore } from './health/store'
import { OffsetCache } from './playback/offset-cache'
import { UserStore } from './state'
import { invokeData, rpc, type Services } from './ipc'
import { checkUpdate } from './updates'

if (process.env.PANDA_USER_DATA_DIR) app.setPath('userData', resolve(process.env.PANDA_USER_DATA_DIR))
app.setName('Panda')
app.setAppUserModelId('com.panda.desktop')

const rendererPath = join(__dirname, '../renderer/index.html')
const devUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined
let mainWindow: BrowserWindow | undefined
let data: DoubanDataSource | undefined
let proxy: MediaProxy | undefined
let health: SourceHealthStore | undefined
let closingNonce: string | undefined
let closeTimer: ReturnType<typeof setTimeout> | undefined
let boundsTimer: ReturnType<typeof setTimeout> | undefined
let canClose = false
// Automated UI replay must not take focus away from the person using the machine.
// This only changes how the test window is shown; normal launches still focus it.
const showInactive = process.env.PANDA_E2E_SHOW_INACTIVE === '1'

function trustedUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    return devUrl ? url.origin === new URL(devUrl).origin : url.protocol === 'file:' && fileURLToPath(url) === rendererPath
  } catch { return false }
}
function trusted(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return Boolean(mainWindow && event.sender === mainWindow.webContents && event.senderFrame === mainWindow.webContents.mainFrame && trustedUrl(event.senderFrame.url))
}
function windowState() { return { maximized: mainWindow?.isMaximized() ?? false, fullscreen: mainWindow?.isFullScreen() ?? false } }
function emitWindowState() { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('panda:window', windowState()) }
interface SavedWindowState {
  bounds: Partial<Electron.BrowserWindowConstructorOptions>
  maximized: boolean
}
function readBounds(): SavedWindowState {
  try {
    const value = JSON.parse(readFileSync(join(app.getPath('userData'), 'window.json'), 'utf8'))
    const { x, y, width, height } = value
    if (![x, y, width, height].every(Number.isFinite) || width < 1000 || height < 600 || width > 10000 || height > 10000) return { bounds: {}, maximized: false }
    const visible = screen.getAllDisplays().some(({ workArea: a }) => x + width > a.x + 100 && x < a.x + a.width - 100 && y >= a.y && y < a.y + a.height - 100)
    return { bounds: visible ? { x, y, width, height } : {}, maximized: value.maximized === true }
  } catch { return { bounds: {}, maximized: false } }
}
function saveBounds() {
  clearTimeout(boundsTimer)
  boundsTimer = undefined
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isFullScreen()) return
  const path = join(app.getPath('userData'), 'window.json')
  try {
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(path + '.tmp', JSON.stringify({ ...mainWindow.getNormalBounds(), maximized: mainWindow.isMaximized() }))
    renameSync(path + '.tmp', path)
  } catch { /* Geometry is optional. User data writes use the error-reporting store. */ }
}
function scheduleSaveBounds() {
  clearTimeout(boundsTimer)
  boundsTimer = setTimeout(saveBounds, 250)
  boundsTimer.unref?.()
}
async function finishClose() {
  if (canClose) return
  canClose = true
  clearTimeout(closeTimer)
  saveBounds()
  await data?.flush()
  await health?.close()
  mainWindow?.close()
}
async function loadRenderer(window: BrowserWindow) {
  const contents = window.webContents
  const closing = () => Boolean(closingNonce || canClose || window.isDestroyed() || contents.isDestroyed())
  const load = () => devUrl ? window.loadURL(devUrl) : window.loadFile(rendererPath)
  let finished = false
  const didFinish = () => { finished = trustedUrl(contents.getURL()) }
  contents.on('did-finish-load', didFinish)
  try {
    await load()
  } catch (error) {
    if (closing()) return
    if ((error as { code?: string }).code !== 'ERR_ABORTED') throw error
    // A renderer reload replaces the first navigation. Await its result rather
    // than treating the cancelled loadFile promise as an application failure.
    if (contents.isLoadingMainFrame() && trustedUrl(contents.getURL())) {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer)
          contents.removeListener('did-finish-load', complete)
          contents.removeListener('did-fail-load', failed)
          contents.removeListener('destroyed', closed)
        }
        const complete = () => { cleanup(); trustedUrl(contents.getURL()) ? resolve() : reject(error) }
        const failed = (_event: Electron.Event, code: number, description: string, _url: string, mainFrame: boolean) => {
          if (!mainFrame || code === -3) return
          cleanup(); closing() ? resolve() : reject(Object.assign(new Error(description), { code: description, errno: code }))
        }
        const closed = () => { cleanup(); resolve() }
        const timer = setTimeout(() => { cleanup(); reject(new Error('Renderer navigation timed out')) }, 30000)
        contents.on('did-finish-load', complete)
        contents.on('did-fail-load', failed)
        contents.once('destroyed', closed)
      })
    } else if (!finished || !trustedUrl(contents.getURL())) {
      await load()
    }
  } finally {
    if (!contents.isDestroyed()) contents.removeListener('did-finish-load', didFinish)
  }
}
async function createWindow() {
  const restoredWindow = readBounds()
  const rules = resolveSourceRules(join(app.getPath('userData'), SOURCE_RULES_FILE), message => console.info('[media]', message))
  proxy = new MediaProxy({ rules, imageDir: join(app.getPath('userData'), 'images'), onSlowImage: report => console.info('[image]', JSON.stringify(report)), onDiagnostic: (source, result) => {
    if (result.removedSegments || ['safety-limit', 'ad-block-too-long', 'encrypted-implicit-iv', 'unclosed-ad-break'].includes(result.reason)) console.info('[media]', source, JSON.stringify(result))
  } })
  await proxy.start()
  const calibration = loadRuleCalibration(join(app.getAppPath(), 'resources/rule-calibration.json'))
  health = calibration
    ? new SourceHealthStore(join(app.getPath('userData'), 'source-health-v1.json'), calibration.health, calibration.budget)
    : undefined
  const offsets = calibration
    ? new OffsetCache(join(app.getPath('userData'), 'align-offsets-v1.json'), calibration.alignment.offsetTtlDays, calibration.alignment.ratioTolerance)
    : undefined
  const noticeTimes = new Map<string, number>()
  data = new DoubanDataSource({
    imageUrl: url => proxy!.registerImage(url),
    cacheDir: join(app.getPath('userData'), 'cache'),
    searchTitlesDir: join(app.getAppPath(), 'resources'),
    onSearchDiagnostic: event => console.info('[search]', JSON.stringify(event)),
    fetch: createTransport(),
    onHome: feed => mainWindow?.webContents.send('panda:home', feed),
    onWarning: warning => {
      const now = Date.now(), key = warning.code
      console.info('[metadata]', warning.operation, warning.code)
      if (now - (noticeTimes.get(key) ?? 0) < 60000) return
      noticeTimes.set(key, now)
      mainWindow?.webContents.send('panda:notice', { code: key, message: key === 'CACHED' ? extra.cachedMetadata : key === 'STORAGE' ? extra.saveError : extra.partialMetadata })
    }
  })
  // The home page is what the window opens on: read it while the window is still being built.
  void data.home().catch(() => { /* The page's own request reports the failure. */ })
  let user: UserStore | undefined
  const userPath = join(app.getPath('userData'), 'user-v1.json')
  const getUser = () => user ??= new UserStore(userPath)
  const services: Services = {
    data,
    playback: new PlaybackService({ proxy, rules, health, onSourceFailure: (source, reason, ms) => console.info('[source]', source, reason, ms + 'ms') }),
    health,
    offsets,
    alignment: calibration?.alignment,
    buffer: calibration?.buffer,
    budget: calibration?.budget,
    user: getUser,
    changed: () => mainWindow?.webContents.send('panda:user', getUser().get()),
    recovery: () => UserStore.recovery(userPath),
    recover: restoreBackup => { user = UserStore.recover(userPath, restoreBackup); return user.get() }
  }
  mainWindow = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1080, minHeight: 640, ...restoredWindow.bounds,
    frame: false, show: false, backgroundColor: '#0e0d0b',
    autoHideMenuBar: true, title: t.app.name,
    icon: join(app.getAppPath(), 'resources/app-icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true, sandbox: true, nodeIntegration: false,
      webSecurity: true, spellcheck: false
    }
  })
  if (restoredWindow.maximized) mainWindow.maximize()
  mainWindow.setMenu(null)
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event, url) => { if (!trustedUrl(url)) event.preventDefault() })
  mainWindow.webContents.on('will-attach-webview', event => event.preventDefault())
  ipcMain.handle('panda:invoke', async (event, method: unknown, args: unknown) => {
    if (!trusted(event) || typeof method !== 'string' || method.length > 40 || !Array.isArray(args) || args.length > 4) return { ok: false, error: { code: 'INVALID_INPUT', message: extra.invalidInput } }
    return rpc(async () => {
      switch (method) {
        case 'window.state': return windowState()
        case 'window.minimize': mainWindow!.minimize(); return
        case 'window.maximize': mainWindow!.isMaximized() ? mainWindow!.unmaximize() : mainWindow!.maximize(); return
        case 'window.close': setImmediate(() => mainWindow?.close()); return
        case 'window.fullscreen':
          if (typeof args[0] !== 'boolean') throw new Error('INVALID_INPUT')
          mainWindow!.setFullScreen(args[0]); return
        case 'app.info': return { version: app.getVersion() }
        case 'app.checkUpdate': return checkUpdate(app.getVersion())
        case 'user.exportRecovery': {
          const contents = UserStore.recoveryExport(userPath)
          const result = await dialog.showSaveDialog(mainWindow!, {
            title: extra.exportRecovery, defaultPath: join(app.getPath('documents'), 'Panda-recovery.json'),
            filters: [{ name: 'JSON', extensions: ['json'] }], properties: ['dontAddToRecent'],
          })
          if (result.canceled || !result.filePath) return { status: 'cancelled' }
          if ([userPath, `${userPath}.bak`].some(path => resolve(path).toLowerCase() === resolve(result.filePath).toLowerCase())) throw new Error('INVALID_INPUT')
          try { writeFileSync(result.filePath, contents, { mode: 0o600, flush: true }) }
          catch (cause) { throw new Error('STATE_WRITE_FAILED', { cause }) }
          return { status: 'saved' }
        }
        default: return invokeData(method, args, services)
      }
    }, method === 'data.playback' || method === 'data.retryPlayback' || method === 'data.playbackFrom' || method === 'playback.prepareSwitch' || method === 'data.availability')
  })
  ipcMain.on('panda:close-ready', (event, nonce: unknown) => {
    if (trusted(event) && typeof nonce === 'string' && nonce === closingNonce) void finishClose()
  })
  mainWindow.on('maximize', emitWindowState)
  mainWindow.on('unmaximize', emitWindowState)
  mainWindow.on('resize', scheduleSaveBounds)
  mainWindow.on('move', scheduleSaveBounds)
  mainWindow.on('maximize', scheduleSaveBounds)
  mainWindow.on('unmaximize', scheduleSaveBounds)
  mainWindow.on('enter-full-screen', emitWindowState)
  mainWindow.on('leave-full-screen', emitWindowState)
  mainWindow.once('ready-to-show', () => showInactive ? mainWindow?.showInactive() : mainWindow?.show())
  mainWindow.on('close', event => {
    if (canClose) return
    event.preventDefault()
    if (closingNonce) return
    closingNonce = randomUUID()
    mainWindow!.webContents.send('panda:closing', closingNonce)
    closeTimer = setTimeout(() => void finishClose(), 2000)
  })
  mainWindow.on('closed', () => { services.libraryRequests?.forEach(controller => controller.abort()); mainWindow = undefined; void proxy?.close() })
  await loadRenderer(mainWindow)
}

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => {
    if (mainWindow?.isMinimized()) mainWindow.restore()
    if (showInactive) { mainWindow?.showInactive(); return }
    mainWindow?.show(); mainWindow?.focus()
  })
  app.whenReady().then(createWindow).catch(async error => {
    if (closingNonce || canClose) { await proxy?.close(); return }
    const failure = { at: new Date().toISOString(), version: app.getVersion(), code: error?.code, errno: error?.errno, message: error instanceof Error ? error.message.slice(0, 1000) : 'Unknown startup error' }
    console.error('[startup]', JSON.stringify(failure))
    try { mkdirSync(app.getPath('userData'), { recursive: true }); writeFileSync(join(app.getPath('userData'), 'startup-error.json'), JSON.stringify(failure, null, 2)) } catch { /* Keep the visible startup failure when diagnostic storage is unavailable. */ }
    dialog.showErrorBox(t.app.name, extra.startFailed)
    await proxy?.close()
    app.exit(1)
  })
  app.on('window-all-closed', () => app.quit())
}
