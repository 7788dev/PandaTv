// Isolated visual/state fixtures. This entrypoint is excluded from the installer.
const { app, BrowserWindow, ipcMain } = require('electron');
const { join, resolve, extname } = require('node:path');
const { readFileSync, existsSync } = require('node:fs');
const { createServer } = require('node:http');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } }).outputText, filename);
const root = resolve(__dirname, '..');
const design = join(root, 'design');
const catalog = require('../design/mock/catalog.json');
const { createMockSource, createMockUser } = require('../design/mock/source.ts');
const copy = require('../design/copy/zh-CN.json');
app.setPath('userData', process.env.PANDA_USER_DATA_DIR);
let win, reference, server, origin, source, mode = 'normal';
let user = createMockUser(catalog);
user.settings.muted = true;
const clone = value => structuredClone(value);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4' };

function changed() { win.webContents.send('panda:user', clone(user)); }
function state() { return { maximized: win.isMaximized(), fullscreen: win.isFullScreen() }; }
function dispatch(action) {
  switch (action.type) {
    case 'favorite': user.favorites = user.favorites.includes(action.id) ? user.favorites.filter(id => id !== action.id) : [action.id, ...user.favorites]; break;
    case 'history:record': case 'history:restore': user.history = [action.entry, ...user.history.filter(entry => entry.id !== action.entry.id)]; break;
    case 'history:remove': user.history = user.history.filter(entry => entry.id !== action.id); break;
    case 'history:clear': user.history = []; break;
    case 'search:add': user.searches = [action.query, ...user.searches.filter(query => query !== action.query)].slice(0, 8); break;
    case 'search:clear': user.searches = []; break;
    case 'settings': user.settings = { ...user.settings, ...action.patch }; break;
  }
  changed(); return clone(user);
}

let picked = '';
async function invoke(method, args) {
  if (method.startsWith('data.')) {
    if (mode === 'loading') return new Promise(() => {});
    if (mode === 'error' || mode === 'offline' || (mode === 'player-error' && /Playback|playback/.test(method))) throw new Error(mode === 'offline' ? copy.state.offline : copy.state.error);
    const operation = method.slice(5);
    if (mode === 'empty') {
      if (operation === 'home') return { hero: [], shelves: [] };
      if (operation === 'channel') return { items: [], next: null };
      if (['search', 'suggest', 'related', 'byIds'].includes(operation)) return [];
    }
    if (operation === 'availability') { const item = catalog.items.find(item => item.id === args[0]); return { episodes: item?.episodes, episodeTitles: item?.episodeTitles }; }
    // The prototype has one source per episode; `lines` offers two, to exercise the switch.
    if (operation === 'sources') return mode === 'lines' ? { current: picked || 'first', list: [{ key: 'first', name: '线路一' }, { key: 'second', name: '线路二' }] } : { list: [] };
    if (operation === 'playbackFrom') picked = args[2];
    if (operation === 'playback' || operation === 'retryPlayback' || operation === 'playbackFrom') {
      const quality = args[operation === 'playbackFrom' ? 3 : 2] === '480P' ? '480P' : '720P';
      return { url: origin + (mode === 'source-hang' && operation === 'playback' ? '/__stall.mp4' : quality === '480P' ? '/__media-480.mp4' : '/__media-720.mp4') + (operation === 'playbackFrom' ? '?line=' + args[2] : ''), format: 'mp4', quality, qualities: ['720P', '480P'], ...(mode === 'intro' ? { intro: { start: 0, end: 90 } } : {}) };
    }
    return source[operation](...args);
  }
  switch (method) {
    case 'user.get': return clone(user);
    case 'user.dispatch': return dispatch(args[0]);
    case 'window.state': return state();
    case 'window.minimize': win.minimize(); return;
    case 'window.maximize': win.isMaximized() ? win.unmaximize() : win.maximize(); return;
    case 'window.fullscreen': win.setFullScreen(args[0]); return;
    case 'window.close': setImmediate(() => win.close()); return;
    case 'app.info': return { version: '1.0.0' };
    case 'app.checkUpdate': throw new Error('更新服务未配置');
    default: throw new Error('Unknown fixture operation');
  }
}

app.whenReady().then(async () => {
  server = createServer((request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      if (pathname === '/__stall.mp4') { response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': 1000000 }); response.flushHeaders(); return; }
      let filename;
      if (pathname.startsWith('/__media-')) filename = join(__dirname, 'fixtures', pathname.includes('480') ? 'playback-480.mp4' : 'playback-720.mp4');
      else {
        filename = resolve(design, '.' + pathname);
        if (!filename.startsWith(design + '\\') && !filename.startsWith(design + '/')) throw new Error('path');
        if (!existsSync(filename) && pathname.startsWith('/tools/node_modules/@fontsource-variable/')) filename = resolve(root, 'node_modules', pathname.slice('/tools/node_modules/'.length));
      }
      const body = readFileSync(filename);
      const headers = { 'Content-Type': types[extname(filename)] || 'application/octet-stream', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' };
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '');
      if (range) {
        const start = Number(range[1]), end = Math.min(body.length - 1, range[2] ? Number(range[2]) : body.length - 1);
        if (start > end) { response.writeHead(416).end(); return; }
        response.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${body.length}`, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes' }).end(body.subarray(start, end + 1));
      } else response.writeHead(200, { ...headers, 'Content-Length': body.length }).end(body);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
  source = createMockSource(catalog, { asset: path => origin + '/' + path, pageSize: Number(process.env.PANDA_FIXTURE_PAGE_SIZE) || 30 });
  win = new BrowserWindow({ width: 1440, height: 900, frame: false, backgroundColor: '#0e0d0b', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: join(root, 'out/preload/index.js') } });
  win.setMenu(null);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  for (const event of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) win.on(event, () => win.webContents.send('panda:window', state()));
  ipcMain.handle('panda:invoke', async (_event, method, args) => { try { return { ok: true, value: await invoke(method, args) }; } catch (error) { return { ok: false, error: { code: 'FIXTURE', message: error.message } }; } });
  global.__fixture = {
    setMode(value) { mode = value; },
    setUser(patch) { user = { ...user, ...patch, settings: { ...user.settings, ...patch.settings } }; changed(); },
    reset() { mode = 'normal'; user = createMockUser(catalog); user.settings.muted = true; changed(); },
    async prototype() {
      reference = new BrowserWindow({ width: 1440, height: 900, frame: false, backgroundColor: '#0e0d0b', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
      reference.setMenu(null); await reference.loadURL(origin + '/preview/index.html'); return reference.id;
    },
  };
  await win.loadFile(join(root, 'out/renderer/index.html'));
});
app.on('window-all-closed', () => { server?.closeAllConnections(); server?.close(); app.quit(); });
