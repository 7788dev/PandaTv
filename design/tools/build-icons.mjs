// 图标构建：node design/tools/build-icons.mjs
// 从 lucide-static 挑出本项目用到的线性图标，加上自绘的实心播放键 / 窗口按钮，
// 输出 design/icons/svg/*.svg（单个文件）、design/icons/sprite.svg（精灵）、design/icons/names.ts（类型）。
// 应用里永远只通过 <Icon name="…" /> 使用，不允许再装别的图标库。
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const LUCIDE = join(ROOT, 'tools/node_modules/lucide-static')
const OUT = join(ROOT, 'icons')

// 本项目的名字 → lucide 的名字。名字按"用途"起，不按"长相"起。
const FROM_LUCIDE = {
  // 通用
  search: 'search',
  user: 'user-round',
  settings: 'settings',
  'chevron-left': 'chevron-left',
  'chevron-right': 'chevron-right',
  'chevron-down': 'chevron-down',
  'chevron-up': 'chevron-up',
  'arrow-left': 'arrow-left',
  'arrow-right': 'arrow-right',
  'arrow-up': 'arrow-up',
  close: 'x',
  check: 'check',
  plus: 'plus',
  minus: 'minus',
  more: 'ellipsis',
  clock: 'clock',
  history: 'history',
  trash: 'trash-2',
  refresh: 'rotate-cw',
  info: 'info',
  alert: 'circle-alert',
  external: 'external-link',
  link: 'link',
  copy: 'copy',
  download: 'download',
  share: 'share-2',
  star: 'star',
  heart: 'heart',
  bookmark: 'bookmark',
  bell: 'bell',
  eye: 'eye',
  'eye-off': 'eye-off',
  filter: 'list-filter',
  sort: 'arrow-up-down',
  calendar: 'calendar',
  folder: 'folder',
  lock: 'lock',
  globe: 'globe',
  // 空状态
  film: 'film',
  tv: 'tv',
  'search-x': 'search-x',
  'cloud-off': 'cloud-off',
  'wifi-off': 'wifi-off',
  // 播放器
  volume: 'volume-2',
  'volume-low': 'volume-1',
  'volume-mute': 'volume-x',
  fullscreen: 'maximize',
  'fullscreen-exit': 'minimize',
  pip: 'picture-in-picture-2',
  forward: 'fast-forward',
  rewind: 'rewind',
  episodes: 'list-video',
  subtitles: 'captions',
  speed: 'gauge',
  sliders: 'sliders-horizontal',
}

// 自绘图标：24×24 网格。实心图形自带 fill，线性图形继承外层的 stroke。
const SOLID = 'fill="currentColor" stroke="none"'
const CUSTOM = {
  play: `<path ${SOLID} d="M7.5 5.13v13.74a1.1 1.1 0 0 0 1.67.94l11.3-6.87a1.1 1.1 0 0 0 0-1.88L9.17 4.19a1.1 1.1 0 0 0-1.67.94Z"/>`,
  pause: `<rect ${SOLID} x="5.75" y="4.25" width="4.5" height="15.5" rx="1.3"/><rect ${SOLID} x="13.75" y="4.25" width="4.5" height="15.5" rx="1.3"/>`,
  next: `<path ${SOLID} d="M4.5 5.6v12.8a1.05 1.05 0 0 0 1.63.87l9.6-6.4a1.05 1.05 0 0 0 0-1.74l-9.6-6.4a1.05 1.05 0 0 0-1.63.87Z"/><rect ${SOLID} x="17.25" y="4.5" width="2.75" height="15" rx="1.2"/>`,
  prev: `<path ${SOLID} d="M19.5 5.6v12.8a1.05 1.05 0 0 1-1.63.87l-9.6-6.4a1.05 1.05 0 0 1 0-1.74l9.6-6.4a1.05 1.05 0 0 1 1.63.87Z"/><rect ${SOLID} x="4" y="4.5" width="2.75" height="15" rx="1.2"/>`,
  // 窗口按钮：画得比普通图标小一圈，线更细，贴近 Windows 11 的标题栏按钮
  'win-min': `<path d="M6.5 12h11"/>`,
  'win-max': `<rect x="6.5" y="6.5" width="11" height="11" rx="2.2"/>`,
  'win-restore': `<rect x="6" y="9" width="9" height="9" rx="2"/><path d="M9.5 8.9V8a2 2 0 0 1 2-2H16a2 2 0 0 1 2 2v4.5a2 2 0 0 1-2 2h-.9"/>`,
  'win-close': `<path d="m6.75 6.75 10.5 10.5M17.25 6.75l-10.5 10.5"/>`,
}

const inner = (svg) => {
  const m = svg.match(/<svg[^>]*>([\s\S]*?)<\/svg>/)
  if (!m) throw new Error('无法解析 SVG')
  return m[1]
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('')
    .replace(/\s+\/>/g, '/>')
}

const icons = {}
for (const [name, src] of Object.entries(FROM_LUCIDE)) {
  let raw
  try {
    raw = readFileSync(join(LUCIDE, 'icons', `${src}.svg`), 'utf8')
  } catch {
    throw new Error(`lucide-static 里没有图标 "${src}"（用于 "${name}"）`)
  }
  icons[name] = inner(raw)
}
Object.assign(icons, CUSTOM)

const names = Object.keys(icons).sort()

rmSync(join(OUT, 'svg'), { recursive: true, force: true })
mkdirSync(join(OUT, 'svg'), { recursive: true })

const ATTRS = 'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"'
for (const name of names) {
  writeFileSync(join(OUT, 'svg', `${name}.svg`), `<svg ${ATTRS} width="24" height="24">${icons[name]}</svg>\n`)
}

const sprite =
  `<svg xmlns="http://www.w3.org/2000/svg">\n` +
  names.map((n) => `<symbol id="${n}" viewBox="0 0 24 24">${icons[n]}</symbol>`).join('\n') +
  `\n</svg>\n`
writeFileSync(join(OUT, 'sprite.svg'), sprite)

writeFileSync(
  join(OUT, 'names.ts'),
  `// 由 design/tools/build-icons.mjs 生成，不要手改。\n` +
    `export const iconNames = [\n${names.map((n) => `  '${n}',`).join('\n')}\n] as const\n\n` +
    `export type IconName = (typeof iconNames)[number]\n`,
)

copyFileSync(join(LUCIDE, 'LICENSE'), join(OUT, 'LICENSE-lucide.txt'))

console.log(`图标 ${names.length} 个 → icons/sprite.svg (${(sprite.length / 1024).toFixed(1)} KB)`)
