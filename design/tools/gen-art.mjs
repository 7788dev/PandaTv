// 演示海报 / 剧照生成器：node design/tools/gen-art.mjs [id ...]
// 读取 design/mock/catalog.json，按下方「美术指导表」为每部片子画一张竖版海报(600×900)
// 和一张横版剧照(1600×900)，输出到 design/art/。全部确定性生成（同一 id 永远得到同一张图）。
// 这些图只是演示素材：真实数据接入后，图片由数据源提供。
import { readFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import opentype from 'opentype.js'
import sharp from 'sharp'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const NM = join(ROOT, 'tools/node_modules')
const loadFont = (file) => {
  const buf = readFileSync(join(NM, '@fontsource/noto-serif-sc/files', file))
  return opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
}
const fontZh = loadFont('noto-serif-sc-chinese-simplified-700-normal.woff')
const fontEn = loadFont('noto-serif-sc-latin-600-normal.woff')

// ───────────────────────── 调色板 ─────────────────────────
// sky: 天空上→下；far/near: 远景→近景；glow: 日/月/灯；title: 海报上部的字；sub: 海报底部的字
const PAL = {
  tealNight: { sky: ['#061821', '#1f5560'], far: '#2f6d78', near: '#04121a', glow: '#f6e6b8', title: '#f5f0e4', sub: '#f5f0e4', accent: '#f2c078' },
  storm: { sky: ['#0d1418', '#46565e'], far: '#5c6e76', near: '#060a0c', glow: '#ffe9b0', title: '#f1efe8', sub: '#f1efe8', accent: '#ffe9b0' },
  duskRose: { sky: ['#2b1a40', '#ea8f6d'], far: '#b5617a', near: '#1a0f25', glow: '#ffdca6', title: '#fff5e8', sub: '#fff5e8', accent: '#ffdca6' },
  amberDusk: { sky: ['#40201a', '#eda95c'], far: '#bd6b3b', near: '#1e0f0b', glow: '#ffe6b0', title: '#fff4e0', sub: '#fff4e0', accent: '#ffe6b0' },
  ember: { sky: ['#0a090c', '#40211b'], far: '#532c24', near: '#060505', glow: '#ff9d57', title: '#f6ece0', sub: '#f6ece0', accent: '#ffb469' },
  noir: { sky: ['#0b0c0f', '#2c2e35'], far: '#3b3d45', near: '#060607', glow: '#e9e4d8', title: '#f1ece2', sub: '#f1ece2', accent: '#e24a3c' },
  goldBlack: { sky: ['#110b06', '#6e481a'], far: '#946325', near: '#090604', glow: '#f3d38f', title: '#f6e3b8', sub: '#f6e3b8', accent: '#f3d38f' },
  jade: { sky: ['#0d221e', '#458f78'], far: '#62a88f', near: '#06130f', glow: '#ecf6d8', title: '#f2f6e8', sub: '#f2f6e8', accent: '#f0d9a0' },
  indigoMist: { sky: ['#11163a', '#98a7dc'], far: '#8190cb', near: '#0a0d26', glow: '#f6f3ff', title: '#f7f5ff', sub: '#f7f5ff', accent: '#ffd8a8' },
  peach: { sky: ['#f1b3a2', '#fbe5c9'], far: '#e58d90', near: '#5c3b61', glow: '#fff8e4', title: '#4b2d50', sub: '#fff4ea', accent: '#ffffff' },
  ocean: { sky: ['#0b6f8a', '#03121d'], far: '#157b96', near: '#020a11', glow: '#c4f1f4', title: '#ebf8f9', sub: '#ebf8f9', accent: '#ffd58a' },
  crimson: { sky: ['#17080b', '#93202a'], far: '#b63f31', near: '#0b0405', glow: '#ffb780', title: '#ffeede', sub: '#ffeede', accent: '#ffc98f' },
  violet: { sky: ['#110a2b', '#5f3190'], far: '#8f55ae', near: '#090617', glow: '#ffc8de', title: '#fbefff', sub: '#fbefff', accent: '#86e6e2' },
  sandBlue: { sky: ['#8ab4c8', '#f3e2c4'], far: '#6c9bb0', near: '#244759', glow: '#fffaea', title: '#1e3b4b', sub: '#f6f1e4', accent: '#f08a5d' },
  tropic: { sky: ['#4eb0c5', '#fbe9b8'], far: '#3b90a6', near: '#184c5e', glow: '#fff5c8', title: '#143c4b', sub: '#f8f3e2', accent: '#f08a5d' },
  snowDay: { sky: ['#aebdd0', '#eef1f5'], far: '#c9d3df', near: '#f7f9fb', glow: '#ffffff', title: '#28384c', sub: '#28384c', accent: '#f0a04b' },
  snowNight: { sky: ['#0b1330', '#3d5388'], far: '#7f93c0', near: '#e3eaf7', glow: '#fdf6d8', title: '#f4f7ff', sub: '#22304e', accent: '#ffc56e' },
  forest: { sky: ['#08160f', '#3f6f52'], far: '#74a07b', near: '#040b08', glow: '#eff7cb', title: '#f0f5e2', sub: '#f0f5e2', accent: '#f0d48a' },
  bamboo: { sky: ['#0c1f1a', '#4f9479'], far: '#7dbb9c', near: '#051009', glow: '#eaf7dc', title: '#f1f7ea', sub: '#f1f7ea', accent: '#f0d48a' },
  autumn: { sky: ['#f7dcae', '#f2b571'], far: '#e39152', near: '#5b301e', glow: '#fff3d4', title: '#4b2516', sub: '#fff3df', accent: '#ffffff' },
  warmNight: { sky: ['#101730', '#30407a'], far: '#3d4e88', near: '#080d20', glow: '#ffd27a', title: '#f6f1e4', sub: '#f6f1e4', accent: '#ffd27a' },
  lunar: { sky: ['#040508', '#141720'], far: '#a3a5ae', near: '#2c2d34', glow: '#86b9ff', title: '#eef0f5', sub: '#eef0f5', accent: '#86b9ff' },
  rice: { sky: ['#f4e3a6', '#fbf3d8'], far: '#c9b54a', near: '#2f5a34', glow: '#fffbe6', title: '#2c4a25', sub: '#fbf6e0', accent: '#ffffff' },
  mustard: { bg: '#f0c350', colors: ['#27304a', '#e2523f', '#fff6e2', '#2f8f83'], title: '#27304a', sub: '#27304a' },
  coral: { bg: '#f2e9dc', colors: ['#e2523f', '#27304a', '#f0c350', '#7fb7a4'], title: '#27304a', sub: '#27304a' },
  stage: { bg: '#170f1c', colors: ['#8c1f2b', '#f3c56b', '#f6ecdc', '#5a1620'], title: '#f6ecdc', sub: '#f6ecdc' },
  paperInk: { paper: '#ece6d7', ink: '#1b1a17', wash: '#4a4843', glow: '#c8402f', title: '#1b1a17', sub: '#1b1a17', accent: '#c8402f' },
  qinglv: { paper: '#eae1c9', ink: '#12434c', wash: '#3a9383', glow: '#d59c2a', title: '#113c44', sub: '#113c44', accent: '#c8402f' },
  celadon: { paper: '#dfe8dd', ink: '#27564c', wash: '#72a896', glow: '#c8402f', title: '#1f4a41', sub: '#1f4a41', accent: '#c8402f' },
}

// ───────────────────────── 美术指导表 ─────────────────────────
// scene: 画哪种场景；pal: 调色板；v: 竖排片名(默认) / h: 横排；其余为该场景的开关
const ART = {
  'wugang-laixin': { scene: 'sea', pal: 'tealNight', lighthouse: true, fog: true },
  'changye-jiangming': { scene: 'city', pal: 'ember', sun: true, lit: 0.1 },
  qingci: { scene: 'ink', pal: 'celadon', boat: true },
  'jiuchong-que': { scene: 'gates', pal: 'goldBlack' },
  'nifeng-xiatian': { scene: 'bloom', pal: 'peach' },
  guiyan: { scene: 'ridges', pal: 'amberDusk', geese: true },
  'diqige-zhengren': { scene: 'dots', pal: 'noir', layout: 'h' },
  'chaoxi-zhishang': { scene: 'sea', pal: 'sandBlue', boat: true },
  'shenhai-huisheng': { scene: 'deep', pal: 'ocean' },
  'yun-shenchu': { scene: 'ridges', pal: 'indigoMist', mist: 0.5, layers: 6 },
  'huijin-zhicheng': { scene: 'city', pal: 'crimson', sun: true, lit: 0.22 },
  'dierci-chuxue': { scene: 'snow', pal: 'snowNight', cabin: true },
  'dengta-shouwangzhe': { scene: 'sea', pal: 'storm', lighthouse: true, beam: true },
  'weigang-fengyun': { scene: 'city', pal: 'goldBlack', lit: 0.4, sun: true },
  'beiwei-sanshidu': { scene: 'road', pal: 'amberDusk' },
  'zuihou-dulun': { scene: 'sea', pal: 'duskRose', boat: true },
  'yueqiu-beimian': { scene: 'orbit', pal: 'lunar', kind: 'surface' },
  'liusha-zhixia': { scene: 'dunes', pal: 'amberDusk', figure: true },
  'xueguo-laike': { scene: 'snow', pal: 'snowDay', cabin: true, tree: true },
  anhe: { scene: 'forest', pal: 'forest' },
  'tade-cheng': { scene: 'city', pal: 'duskRose', sun: true, lit: 0.3 },
  'zuihou-xunyingren': { scene: 'ridges', pal: 'snowNight', eagle: true, layers: 4, snowcap: true },
  'nihong-yibei': { scene: 'city', pal: 'violet', lit: 0.45 },
  'linghao-chengke': { scene: 'road', pal: 'crimson', rails: true },
  'xiaoyuan-chunqiu': { scene: 'geo', pal: 'mustard', layout: 'h' },
  'xiangshan-erxing': { scene: 'ridges', pal: 'jade', figure: true },
  'chufangli-xiatian': { scene: 'geo', pal: 'coral', layout: 'h' },
  'zhoumo-lvxingshe': { scene: 'sea', pal: 'tropic', boat: true, layout: 'h' },
  'jinwan-kaimai': { scene: 'spot', pal: 'stage', layout: 'h' },
  'tingjian-haoshiguang': { scene: 'bloom', pal: 'violet' },
  'shanhai-huijuan': { scene: 'ink', pal: 'qinglv', birds: true },
  'xinggui-lieche': { scene: 'orbit', pal: 'violet', kind: 'ring' },
  'mao-yu-bianlidian': { scene: 'city', pal: 'warmNight', lit: 0.55, low: true },
  'tingyu-jian': { scene: 'forest', pal: 'bamboo', bamboo: true, rain: true },
  'jixie-zhixin': { scene: 'dunes', pal: 'crimson', figure: true },
  'xiaohuli-siji': { scene: 'forest', pal: 'autumn', leaves: true },
  'shenkong-youchai': { scene: 'orbit', pal: 'tealNight', kind: 'planet' },
  'kanbujian-heliu': { scene: 'river', pal: 'jade' },
  'jidi-riji': { scene: 'snow', pal: 'snowNight', aurora: true },
  'yilimi-lvcheng': { scene: 'dunes', pal: 'rice', terraces: true },
  shouyiren: { scene: 'ink', pal: 'paperInk', boat: true },
  'chengshi-yewan': { scene: 'city', pal: 'tealNight', lit: 0.5 },
}

// ───────────────────────── 基础工具 ─────────────────────────
function hashSeed(str) {
  let h = 2166136261
  for (const ch of str) h = Math.imul(h ^ ch.codePointAt(0), 16777619)
  return h >>> 0
}
function mulberry32(a) {
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const lerp = (a, b, t) => a + (b - a) * t
const f = (n) => Number(n.toFixed(1))
const hex2rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
const mix = (a, b, t) => {
  const A = hex2rgb(a)
  const B = hex2rgb(b)
  return '#' + A.map((v, i) => Math.round(lerp(v, B[i], t)).toString(16).padStart(2, '0')).join('')
}

function makeCtx(W, H, seed, pal, o, wide) {
  const rng = mulberry32(seed)
  let uid = 0
  return {
    W,
    H,
    M: Math.min(W, H),
    rng,
    pal,
    o,
    wide,
    defs: [],
    fx: wide ? 0.68 : (o.fx ?? 0.42),
    id: (p) => `${p}${++uid}`,
    R: (a, b) => a + (b - a) * rng(),
  }
}
const stopsXml = (stops) =>
  stops
    .map((s, i) => {
      const [col, op = 1, off = i / (stops.length - 1)] = Array.isArray(s) ? s : [s]
      return `<stop offset="${off}" stop-color="${col}" stop-opacity="${op}"/>`
    })
    .join('')
function lin(c, stops, x1 = 0, y1 = 0, x2 = 0, y2 = 1, user = false) {
  const id = c.id('l')
  c.defs.push(`<linearGradient id="${id}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"${user ? ' gradientUnits="userSpaceOnUse"' : ''}>${stopsXml(stops)}</linearGradient>`)
  return `url(#${id})`
}
function rad(c, stops, cx = 0.5, cy = 0.5, r = 0.5, user = false) {
  const id = c.id('r')
  c.defs.push(`<radialGradient id="${id}" cx="${cx}" cy="${cy}" r="${r}"${user ? ' gradientUnits="userSpaceOnUse"' : ''}>${stopsXml(stops)}</radialGradient>`)
  return `url(#${id})`
}
function blur(c, std) {
  const id = c.id('b')
  c.defs.push(`<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${std}"/></filter>`)
  return `url(#${id})`
}
const rect = (x, y, w, h, fill, extra = '') => `<rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" fill="${fill}" ${extra}/>`
const circ = (x, y, r, fill, extra = '') => `<circle cx="${f(x)}" cy="${f(y)}" r="${f(r)}" fill="${fill}" ${extra}/>`
const path = (d, fill, extra = '') => `<path d="${d}" fill="${fill}" ${extra}/>`
const line = (x1, y1, x2, y2, stroke, w, extra = '') => `<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" stroke="${stroke}" stroke-width="${w}" stroke-linecap="round" ${extra}/>`

const sky = (c, h = c.H) => rect(0, 0, c.W, h, lin(c, c.pal.sky))
function sun(c, x, y, r, col = c.pal.glow, k = 3.6, op = 0.5) {
  return circ(x, y, r * k, rad(c, [[col, op], [col, op * 0.3, 0.42], [col, 0]])) + circ(x, y, r, col)
}
function stars(c, n, col = '#ffffff', yMax = 1) {
  let s = ''
  for (let i = 0; i < n; i++) s += circ(c.R(0, c.W), c.R(0, c.H * yMax), c.R(0.5, 1.7), col, `opacity="${f(c.R(0.15, 0.9))}"`)
  return s
}
// 折线山脊（中点位移）：返回点集
function ridgePts(c, base, amp, rough = 0.62, depth = 6) {
  let pts = [
    [-4, base - amp * c.R(-0.1, 0.5)],
    [c.W + 4, base - amp * c.R(-0.1, 0.5)],
  ]
  let range = amp
  for (let d = 0; d < depth + (c.wide ? 1 : 0); d++) {
    const next = []
    for (let i = 0; i < pts.length - 1; i++) {
      const [x1, y1] = pts[i]
      const [x2, y2] = pts[i + 1]
      next.push(pts[i], [(x1 + x2) / 2, (y1 + y2) / 2 + (c.rng() - 0.5) * 2 * range])
    }
    next.push(pts.at(-1))
    pts = next
    range *= rough
  }
  return pts
}
const closeDown = (c, pts) => `M-4,${c.H + 4} L` + pts.map(([x, y]) => `${f(x)},${f(y)}`).join(' ') + ` L${c.W + 4},${c.H + 4}Z`
// 平滑曲线（Catmull-Rom → 贝塞尔）
function smooth(pts) {
  let d = `M${f(pts[0][0])},${f(pts[0][1])}`
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[i + 2] || p2
    d += ` C${f(p1[0] + (p2[0] - p0[0]) / 6)},${f(p1[1] + (p2[1] - p0[1]) / 6)} ${f(p2[0] - (p3[0] - p1[0]) / 6)},${f(p2[1] - (p3[1] - p1[1]) / 6)} ${f(p2[0])},${f(p2[1])}`
  }
  return d
}
function hillPts(c, base, amp, n = 6) {
  const pts = []
  for (let i = 0; i <= n; i++) pts.push([lerp(-20, c.W + 20, i / n), base - amp * c.R(0, 1)])
  return pts
}
const hill = (c, pts) => smooth(pts) + ` L${c.W + 20},${c.H + 4} L-20,${c.H + 4}Z`
function yAt(pts, x) {
  for (let i = 0; i < pts.length - 1; i++) {
    if (x >= pts[i][0] && x <= pts[i + 1][0]) {
      const t = (x - pts[i][0]) / (pts[i + 1][0] - pts[i][0] || 1)
      return lerp(pts[i][1], pts[i + 1][1], t)
    }
  }
  return pts.at(-1)[1]
}
function figure(x, y, h, col) {
  const hd = h * 0.17
  return (
    circ(x, y - h + hd, hd, col) +
    path(`M${f(x - h * 0.15)},${f(y)} L${f(x - h * 0.1)},${f(y - h * 0.6)} Q${f(x)},${f(y - h * 0.72)} ${f(x + h * 0.1)},${f(y - h * 0.6)} L${f(x + h * 0.15)},${f(y)}Z`, col)
  )
}
function bird(x, y, s, col, w = 1.6) {
  return `<path d="M${f(x - 8 * s)},${f(y - 2.5 * s)} Q${f(x - 3.5 * s)},${f(y - 5.5 * s)} ${f(x)},${f(y)} Q${f(x + 3.5 * s)},${f(y - 5.5 * s)} ${f(x + 8 * s)},${f(y - 2.5 * s)}" fill="none" stroke="${col}" stroke-width="${f(w * s)}" stroke-linecap="round" stroke-linejoin="round"/>`
}
function mistBand(c, y, h, col, op) {
  return rect(0, y, c.W, h, lin(c, [[col, 0], [col, op], [col, 0]]))
}

// ───────────────────────── 场景 ─────────────────────────
const SCENES = {
  // 层叠远山
  ridges(c) {
    const { W, H, M, pal, o } = c
    const n = o.layers ?? 5
    const sx = W * c.fx
    const sy = H * (c.wide ? 0.36 : 0.34)
    const sr = M * (c.wide ? 0.15 : 0.14)
    let s = sky(c)
    if (pal.sky[0] < '#3') s += stars(c, c.wide ? 120 : 70, '#fff', 0.5)
    s += sun(c, sx, sy, sr)
    if (o.geese) {
      const gx = sx - sr * (c.wide ? 3.4 : 1.2)
      const gy = sy - sr * 1.5
      for (let i = 0; i < 7; i++) {
        const k = i - 2
        s += bird(gx + k * 21 * (M / 600), gy + Math.abs(k) * 12 * (M / 600), M / 600, mix(pal.near, pal.far, 0.2), 2)
      }
    }
    let figureAt = null
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1)
      const base = H * lerp(c.wide ? 0.54 : 0.52, 0.93, t)
      const amp = H * lerp(0.13, 0.07, t)
      const pts = ridgePts(c, base, amp, lerp(0.52, 0.66, t), 4 + Math.round(t * 2))
      const col = mix(pal.far, pal.near, Math.pow(t, 0.8))
      s += path(closeDown(c, pts), col)
      if (o.snowcap && i < 2) {
        // 山顶覆雪：把山脊上部描一条亮边
        s += `<path d="M${pts.map(([x, y]) => `${f(x)},${f(y)}`).join(' L')}" fill="none" stroke="${pal.near}" stroke-opacity="0.5" stroke-width="${f(M * 0.012)}" stroke-linejoin="round"/>`
      }
      if (i === n - 2) figureAt = pts
      if (i < n - 1) s += mistBand(c, base - amp * 0.1, H * 0.17, pal.sky[1], o.mist ?? 0.3)
    }
    if (o.figure && figureAt) {
      const x = W * (c.wide ? 0.56 : 0.3)
      s += figure(x, yAt(figureAt, x) + 2, M * 0.036, pal.near)
    }
    if (o.eagle) s += bird(sx - sr * 2.2, sy + sr * 0.2, (M / 600) * 2.6, c.wide ? pal.sky[0] : pal.sky[0], 1.5)
    return s
  },

  // 海与落日 / 灯塔
  sea(c) {
    const { W, H, M, pal, o } = c
    const hz = H * (c.wide ? 0.62 : 0.6)
    const sx = W * c.fx
    const sr = M * 0.12
    const dark = pal.sky[0] < '#5'
    let s = sky(c, hz + 2)
    if (dark && pal.sky[0] < '#2') s += stars(c, c.wide ? 110 : 60, '#fff', 0.5)
    s += sun(c, sx, hz - sr * (o.lighthouse ? 1.7 : 0.55), sr * (o.lighthouse ? 0.62 : 1), pal.glow, o.lighthouse ? 4.2 : 3.4)
    // 远岛
    const isl = ridgePts(c, hz + 6, H * 0.055, 0.6, 4)
    s += path(closeDown(c, isl), mix(pal.far, pal.sky[1], 0.35))
    // 海面
    s += rect(0, hz, W, H - hz, lin(c, [mix(pal.far, pal.near, 0.3), pal.near]))
    // 倒影
    const sunW = sr * (o.lighthouse ? 1.1 : 1.9)
    for (let k = 0; k < 22; k++) {
      const y = hz + 6 + k * (H - hz) * 0.042
      const w = sunW * (1 - k * 0.034) * c.R(0.45, 1.25)
      s += rect(sx - w / 2 + c.R(-8, 8), y, w, Math.max(2, M * 0.006), pal.glow, `rx="2" opacity="${f(0.72 - k * 0.03)}"`)
    }
    for (let k = 0; k < (c.wide ? 70 : 34); k++) {
      const y = c.R(hz + 10, H)
      const w = c.R(14, 70) * (0.4 + (y - hz) / (H - hz))
      s += rect(c.R(0, W), y, w, 1.6, pal.glow, `rx="1" opacity="${f(c.R(0.05, 0.16))}"`)
    }
    if (o.boat) {
      const bx = W * (c.wide ? 0.44 : 0.72)
      const by = hz + (H - hz) * 0.2
      const k = M / 600
      const col = mix(pal.near, '#000000', 0.25)
      s += path(`M${f(bx - 30 * k)},${f(by)} L${f(bx + 30 * k)},${f(by)} L${f(bx + 22 * k)},${f(by + 9 * k)} L${f(bx - 22 * k)},${f(by + 9 * k)}Z`, col)
      s += path(`M${f(bx - 2 * k)},${f(by - 2 * k)} L${f(bx - 2 * k)},${f(by - 44 * k)} L${f(bx + 22 * k)},${f(by - 4 * k)}Z`, col)
      s += path(`M${f(bx - 5 * k)},${f(by - 2 * k)} L${f(bx - 5 * k)},${f(by - 34 * k)} L${f(bx - 20 * k)},${f(by - 4 * k)}Z`, col)
    }
    if (o.lighthouse) {
      const lx = W * (c.wide ? 0.86 : 0.24)
      const k = M / 600
      const rock = mix(pal.near, '#000000', 0.2)
      const ground = hz + 6
      s += path(`M${f(lx - 150 * k)},${f(ground + 30 * k)} Q${f(lx - 70 * k)},${f(ground - 46 * k)} ${f(lx)},${f(ground - 52 * k)} Q${f(lx + 80 * k)},${f(ground - 40 * k)} ${f(lx + 170 * k)},${f(ground + 30 * k)}Z`, rock)
      const top = ground - 52 * k - 150 * k
      if (o.beam) {
        s += path(`M${f(lx)},${f(top - 10 * k)} L${f(lx - W)},${f(top - 150 * k)} L${f(lx - W)},${f(top + 60 * k)}Z`, lin(c, [[pal.glow, 0], [pal.glow, 0.34]], 0, 0, 1, 0))
      }
      s += path(`M${f(lx - 15 * k)},${f(ground - 48 * k)} L${f(lx - 9 * k)},${f(top)} L${f(lx + 9 * k)},${f(top)} L${f(lx + 15 * k)},${f(ground - 48 * k)}Z`, rock)
      s += rect(lx - 13 * k, top - 5 * k, 26 * k, 5 * k, rock)
      s += rect(lx - 7 * k, top - 20 * k, 14 * k, 15 * k, pal.glow)
      s += path(`M${f(lx - 11 * k)},${f(top - 20 * k)} L${f(lx)},${f(top - 34 * k)} L${f(lx + 11 * k)},${f(top - 20 * k)}Z`, rock)
      s += circ(lx, top - 12 * k, 46 * k, rad(c, [[pal.glow, 0.7], [pal.glow, 0]]))
    }
    if (o.fog) {
      s += mistBand(c, hz - H * 0.13, H * 0.2, pal.sky[1], 0.5)
      s += mistBand(c, hz + H * 0.04, H * 0.16, mix(pal.sky[1], '#ffffff', 0.25), 0.2)
    }
    return s
  },

  // 城市天际线
  city(c) {
    const { W, H, M, pal, o } = c
    const k = M / 600
    let s = sky(c)
    if (pal.sky[0] < '#2') s += stars(c, c.wide ? 90 : 50, '#fff', 0.45)
    const sx = W * c.fx
    if (o.sun) s += sun(c, sx, H * (c.wide ? 0.6 : 0.56), M * 0.17, pal.glow, 3, 0.55)
    else s += sun(c, sx, H * 0.24, M * 0.065, pal.glow, 4.5, 0.3)
    const heights = o.low ? [0.4, 0.3, 0.2] : [0.62, 0.47, 0.29]
    for (let i = 0; i < 3; i++) {
      const col = mix(pal.far, pal.near, [0.1, 0.55, 1][i])
      const lit = (o.lit ?? 0.3) * [0.35, 0.8, 1][i]
      let x = -20 * k
      while (x < W) {
        const bw = c.R(26, 78) * k * [0.8, 1.05, 1.5][i]
        const bh = H * heights[i] * c.R(0.38, 1) * (c.wide ? 1.12 : 1)
        const y = H - bh
        s += rect(x, y, bw, bh + 4, col)
        const roof = c.rng()
        if (roof < 0.22) s += rect(x + bw * 0.42, y - c.R(14, 46) * k, 2.4 * k, 50 * k, col)
        else if (roof < 0.5) s += rect(x + bw * 0.2, y - 9 * k, bw * 0.6, 10 * k, col)
        // 亮窗
        const cols = Math.floor(bw / (11 * k))
        const rows = Math.floor(bh / (15 * k))
        for (let r = 1; r < rows; r++) {
          for (let q = 0; q < cols; q++) {
            if (c.rng() < lit * 0.5) {
              s += rect(x + 5 * k + q * 11 * k, y + r * 15 * k, 4.2 * k, 6.5 * k, pal.accent, `opacity="${f(c.R(0.35, 0.95))}"`)
            }
          }
        }
        x += bw + c.R(-4, 9) * k
      }
      s += mistBand(c, H * (1 - heights[i] * 0.55), H * 0.3, pal.sky[1], [0.34, 0.2, 0][i])
    }
    s += rect(0, H * 0.72, W, H * 0.28, lin(c, [[pal.near, 0], [pal.near, 0.85]]))
    return s
  },

  // 沙丘 / 梯田
  dunes(c) {
    const { W, H, M, pal, o } = c
    let s = sky(c)
    const sx = W * c.fx
    s += sun(c, sx, H * (c.wide ? 0.34 : 0.33), M * (o.terraces ? 0.1 : 0.16), pal.glow, 3.2, 0.5)
    const n = o.terraces ? 9 : 5
    let figLine = null
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1)
      const base = H * lerp(c.wide ? 0.6 : 0.56, 1.02, t)
      const amp = H * (o.terraces ? 0.07 : lerp(0.15, 0.11, t))
      const pts = hillPts(c, base, amp, o.terraces ? 5 : 4)
      const a = mix(mix(pal.far, pal.glow, 0.28), pal.near, t * 0.85)
      const b = mix(pal.far, pal.near, Math.min(1, t * 0.9 + 0.22))
      s += path(hill(c, pts), lin(c, i % 2 ? [a, b] : [b, a], 0, 0, 1, 0.5))
      if (o.terraces) s += `<path d="${smooth(pts)}" fill="none" stroke="${pal.glow}" stroke-opacity="0.35" stroke-width="${f(M * 0.004)}"/>`
      if (i === 1) figLine = pts
    }
    if (o.figure && figLine) {
      const x = W * (c.wide ? 0.5 : 0.3)
      // 平滑曲线上取近似高度
      s += figure(x, yAt(figLine, x) - 2, M * 0.04, mix(pal.near, '#000000', 0.3))
    }
    return s
  },

  // 太空：环形行星 / 月面 / 大行星
  orbit(c) {
    const { W, H, M, pal, o } = c
    const sx = W * c.fx
    let s = rect(0, 0, W, H, pal.sky[0])
    s += circ(sx, H * 0.45, M * 1.1, rad(c, [[mix(pal.sky[1], pal.far, 0.25), 0.9], [pal.sky[1], 0.5, 0.45], [pal.sky[0], 0]]))
    s += stars(c, c.wide ? 300 : 170, '#ffffff')
    if (o.kind === 'surface') {
      // 远处的地球
      const er = M * 0.085
      const ex = sx
      const ey = H * (c.wide ? 0.3 : 0.27)
      s += circ(ex, ey, er * 3.4, rad(c, [[pal.glow, 0.32], [pal.glow, 0]]))
      const cp = c.id('c')
      c.defs.push(`<clipPath id="${cp}"><circle cx="${f(ex)}" cy="${f(ey)}" r="${f(er)}"/></clipPath>`)
      s += circ(ex, ey, er, pal.glow)
      s += circ(ex - er * 0.55, ey + er * 0.3, er * 1.18, '#06070b', `clip-path="url(#${cp})" opacity="0.93"`)
      // 月面
      const R = H * 1.5
      const cy = H * (c.wide ? 0.66 : 0.7) + R
      s += circ(W * 0.5, cy, R, lin(c, [mix(pal.far, '#ffffff', 0.1), pal.near], 0, 0, 0, 0.26))
      for (let i = 0; i < (c.wide ? 16 : 9); i++) {
        const x = c.R(0, W)
        const y = c.R(H * 0.76, H * 0.98)
        const rx = c.R(18, 70) * (M / 600)
        s += `<ellipse cx="${f(x)}" cy="${f(y)}" rx="${f(rx)}" ry="${f(rx * 0.24)}" fill="#000" opacity="${f(c.R(0.12, 0.3))}"/>`
      }
      const fxp = W * (c.wide ? 0.52 : 0.3)
      const dx = fxp - W * 0.5
      const fy = cy - Math.sqrt(R * R - dx * dx)
      s += figure(fxp, fy + 3, M * 0.042, '#07080c')
      s += line(fxp + M * 0.03, fy + 3, fxp + M * 0.03, fy - M * 0.07, '#07080c', M * 0.004)
      return s
    }
    const pr = M * (o.kind === 'ring' ? 0.2 : 0.34)
    const px = o.kind === 'ring' ? sx : W * (c.wide ? 0.82 : 0.6)
    const py = o.kind === 'ring' ? H * (c.wide ? 0.44 : 0.42) : H * (c.wide ? 0.86 : 0.8)
    const body = rad(c, [mix(pal.far, pal.glow, 0.55), [pal.far, 1, 0.5], mix(pal.far, pal.near, 0.82)], 0.34, 0.3, 0.8)
    s += circ(px, py, pr * 2.6, rad(c, [[pal.far, 0.35], [pal.far, 0]]))
    if (o.kind === 'ring') {
      const ring = (clip) =>
        `<g transform="rotate(-20 ${f(px)} ${f(py)})" ${clip}><ellipse cx="${f(px)}" cy="${f(py)}" rx="${f(pr * 2.1)}" ry="${f(pr * 0.5)}" fill="none" stroke="${pal.glow}" stroke-opacity="0.85" stroke-width="${f(pr * 0.1)}"/><ellipse cx="${f(px)}" cy="${f(py)}" rx="${f(pr * 1.72)}" ry="${f(pr * 0.4)}" fill="none" stroke="${pal.accent}" stroke-opacity="0.6" stroke-width="${f(pr * 0.035)}"/></g>`
      const cp = c.id('c')
      c.defs.push(`<clipPath id="${cp}"><rect x="${f(px - pr * 3)}" y="${f(py)}" width="${f(pr * 6)}" height="${f(pr * 3)}" transform="rotate(-20 ${f(px)} ${f(py)})"/></clipPath>`)
      s += ring('')
      s += circ(px, py, pr, body)
      s += ring(`clip-path="url(#${cp})"`)
      s += circ(px + pr * 2.5, py - pr * 1.25, pr * 0.14, mix(pal.glow, '#ffffff', 0.4))
    } else {
      s += circ(px, py, pr, body)
      for (let i = 0; i < 2; i++) {
        s += `<ellipse cx="${f(px)}" cy="${f(py)}" rx="${f(pr * (1.7 + i * 0.55))}" ry="${f(pr * (0.42 + i * 0.16))}" fill="none" stroke="${pal.glow}" stroke-opacity="${0.3 - i * 0.12}" stroke-width="1.4" transform="rotate(-24 ${f(px)} ${f(py)})"/>`
      }
      const shx = W * (c.wide ? 0.6 : 0.32)
      const shy = H * (c.wide ? 0.3 : 0.3)
      const k = M / 600
      s += line(shx - 150 * k, shy + 60 * k, shx, shy, lin(c, [[pal.accent, 0], [pal.accent, 0.9]], shx - 150 * k, shy + 60 * k, shx, shy, true), 2.4 * k)
      s += circ(shx, shy, 4.5 * k, mix(pal.accent, '#ffffff', 0.5))
      s += circ(shx, shy, 18 * k, rad(c, [[pal.accent, 0.6], [pal.accent, 0]]))
    }
    return s
  },

  // 林间：树干 / 竹 / 雨 / 落叶
  forest(c) {
    const { W, H, M, pal, o } = c
    const k = M / 600
    const sx = W * c.fx
    let s = sky(c)
    s += circ(sx, H * 0.26, M * 0.72, rad(c, [[pal.glow, 0.62], [pal.glow, 0.16, 0.5], [pal.glow, 0]]))
    s += path(`M${f(sx - 40 * k)},0 L${f(sx + 60 * k)},0 L${f(sx + 330 * k)},${H} L${f(sx - 250 * k)},${H}Z`, lin(c, [[pal.glow, 0.26], [pal.glow, 0]]))
    const trunk = (x, w, col, op, nodes) => {
      let t = path(`M${f(x - w * 0.42)},-4 L${f(x + w * 0.42)},-4 L${f(x + w * 0.5)},${H + 4} L${f(x - w * 0.5)},${H + 4}Z`, col, `opacity="${op}"`)
      if (nodes) {
        for (let y = c.R(20, 90) * k; y < H; y += c.R(70, 120) * k) t += rect(x - w * 0.5, y, w, Math.max(1.5, w * 0.07), pal.glow, `opacity="${f(op * 0.28)}"`)
      }
      return t
    }
    for (let i = 0; i < W / (20 * k); i++) s += trunk(c.R(0, W), c.R(3, 8) * k, mix(pal.far, pal.sky[1], 0.45), 0.55, false)
    s += mistBand(c, H * 0.36, H * 0.4, pal.sky[1], 0.34)
    for (let i = 0; i < W / (64 * k); i++) s += trunk(c.R(0, W), c.R(11, 22) * k, mix(pal.far, pal.near, 0.6), 0.92, o.bamboo)
    const nearN = c.wide ? 6 : 3
    for (let i = 0; i < nearN; i++) {
      let x = c.R(0, W)
      if (Math.abs(x - sx) < 90 * k) x += 180 * k
      s += trunk(x, c.R(44, 84) * k, pal.near, 1, o.bamboo)
    }
    s += rect(0, H * 0.74, W, H * 0.26, lin(c, [[pal.near, 0], [pal.near, 0.95]]))
    if (o.rain) {
      for (let i = 0; i < (c.wide ? 260 : 130); i++) {
        const x = c.R(-40, W)
        const y = c.R(-40, H)
        const l = c.R(18, 52) * k
        s += line(x, y, x + l * 0.22, y + l, '#ffffff', 1.1 * k, `opacity="${f(c.R(0.1, 0.32))}"`)
      }
    }
    if (o.leaves) {
      for (let i = 0; i < (c.wide ? 70 : 36); i++) {
        const x = c.R(0, W)
        const y = c.R(0, H)
        const r = c.R(3, 8) * k
        s += `<ellipse cx="${f(x)}" cy="${f(y)}" rx="${f(r)}" ry="${f(r * 0.5)}" fill="${c.rng() < 0.5 ? pal.glow : pal.far}" opacity="${f(c.R(0.4, 0.95))}" transform="rotate(${f(c.R(0, 180))} ${f(x)} ${f(y)})"/>`
      }
    }
    return s
  },

  // 几何拼贴（综艺 / 喜剧）
  geo(c) {
    const { W, H, pal } = c
    let s = rect(0, 0, W, H, pal.bg)
    const cols = c.wide ? 8 : 3
    const size = W / cols
    const rows = c.wide ? Math.ceil(H / size) : 3
    const x0 = 0
    let prev = -1
    for (let r = 0; r < rows; r++) {
      for (let q = 0; q < cols; q++) {
        const x = x0 + q * size
        const y = r * size
        let ci = Math.floor(c.R(0, pal.colors.length))
        if (ci === prev) ci = (ci + 1) % pal.colors.length
        prev = ci
        const col = pal.colors[ci]
        const col2 = pal.colors[(ci + 1 + Math.floor(c.R(0, pal.colors.length - 1))) % pal.colors.length]
        const kind = Math.floor(c.R(0, 9))
        const cx = x + size / 2
        const cy = y + size / 2
        if (kind === 0) s += circ(cx, cy, size * 0.5, col)
        else if (kind === 1) s += rect(x, y, size, size, col) + circ(cx, cy, size * 0.3, col2)
        else if (kind === 2) s += path(`M${f(x)},${f(y + size)} A${f(size)},${f(size)} 0 0 1 ${f(x + size)},${f(y)} L${f(x + size)},${f(y + size)}Z`, col)
        else if (kind === 3) s += path(`M${f(x)},${f(y)} A${f(size)},${f(size)} 0 0 1 ${f(x + size)},${f(y + size)} L${f(x)},${f(y + size)}Z`, col)
        else if (kind === 4) s += path(`M${f(x)},${f(cy)} A${f(size / 2)},${f(size / 2)} 0 0 1 ${f(x + size)},${f(cy)}Z`, col) + path(`M${f(x)},${f(cy)} A${f(size / 2)},${f(size / 2)} 0 0 0 ${f(x + size)},${f(cy)}Z`, col2)
        else if (kind === 5) {
          for (let i = 0; i < 4; i++) s += rect(x, y + (i * size) / 4, size, size / 8, col)
        } else if (kind === 6) {
          for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) s += circ(x + ((i + 0.5) * size) / 3, y + ((j + 0.5) * size) / 3, size * 0.075, col)
        } else if (kind === 7) s += path(`M${f(x)},${f(y + size)} L${f(x + size)},${f(y + size)} L${f(x + size)},${f(y)}Z`, col)
        else s += rect(x, y, size, size, col) + path(`M${f(x)},${f(y)} A${f(size)},${f(size)} 0 0 0 ${f(x + size)},${f(y + size)} L${f(x + size)},${f(y)}Z`, col2)
      }
    }
    return s
  },

  // 柔光色团（青春 / 音乐）
  bloom(c) {
    const { W, H, M, pal } = c
    let s = sky(c)
    const bl = blur(c, M * 0.11)
    const cols = [pal.far, pal.glow, pal.accent, pal.near, pal.far]
    for (let i = 0; i < 5; i++) {
      s += circ(c.R(0.05, 0.95) * W, c.R(0.1, 0.9) * H, M * c.R(0.24, 0.44), cols[i], `filter="${bl}" opacity="${f(c.R(0.55, 0.9))}"`)
    }
    const sx = W * c.fx
    const sy = H * (c.wide ? 0.5 : 0.46)
    for (let i = 0; i < 6; i++) s += circ(sx, sy, M * (0.09 + i * 0.065), 'none', `stroke="${pal.glow}" stroke-opacity="${f(0.55 - i * 0.08)}" stroke-width="${f(M * 0.0028)}"`)
    s += circ(sx, sy, M * 0.045, pal.glow)
    return s
  },

  // 水墨 / 青绿山水
  ink(c) {
    const { W, H, M, pal, o } = c
    const k = M / 600
    let s = rect(0, 0, W, H, pal.paper)
    s += rect(0, 0, W, H, rad(c, [['#8a6f3a', 0], ['#8a6f3a', 0.16]], 0.5, 0.5, 0.75))
    const sx = W * (c.wide ? 0.72 : 0.34)
    s += circ(sx, H * (c.wide ? 0.27 : 0.25), M * 0.075, pal.glow)
    const n = 4
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1)
      const base = H * lerp(c.wide ? 0.5 : 0.5, 0.9, t)
      const amp = H * lerp(0.2, 0.09, t)
      const pts = ridgePts(c, base, amp, 0.6, 4 + i)
      const col = mix(pal.wash, pal.ink, t)
      const top = Math.min(...pts.map((p) => p[1]))
      const fill = lin(c, [[col, lerp(0.42, 0.95, t)], [col, lerp(0.2, 0.6, t), 0.55], [col, 0]], 0, top, 0, base + H * 0.2, true)
      s += path(closeDown(c, pts), fill)
    }
    if (o.boat) {
      const bx = W * (c.wide ? 0.4 : 0.62)
      const by = H * (c.wide ? 0.8 : 0.82)
      s += path(`M${f(bx - 26 * k)},${f(by)} Q${f(bx)},${f(by + 9 * k)} ${f(bx + 30 * k)},${f(by - 2 * k)} L${f(bx + 22 * k)},${f(by + 5 * k)} Q${f(bx)},${f(by + 12 * k)} ${f(bx - 20 * k)},${f(by + 5 * k)}Z`, pal.ink)
      s += figure(bx - 4 * k, by + 2 * k, 20 * k, pal.ink)
      s += line(bx + 6 * k, by - 26 * k, bx + 16 * k, by + 12 * k, pal.ink, 1.4 * k)
      for (let i = 0; i < 4; i++) s += rect(bx - 60 * k + i * 12 * k, by + 18 * k + i * 6 * k, (90 - i * 16) * k, 1.4 * k, pal.ink, `opacity="${0.3 - i * 0.06}" rx="1"`)
    }
    if (o.birds) {
      for (let i = 0; i < 5; i++) s += bird(sx + (70 + i * 30) * k + c.R(-8, 8), H * 0.2 + c.R(-22, 30) * k, k * c.R(0.8, 1.2), pal.ink, 1.8)
    }
    return s
  },

  // 雪原 / 极光
  snow(c) {
    const { W, H, M, pal, o } = c
    const k = M / 600
    const night = pal.sky[0] < '#5'
    let s = sky(c)
    const sx = W * c.fx
    if (night) s += stars(c, c.wide ? 150 : 80, '#fff', 0.55)
    if (o.aurora) {
      const bl = blur(c, M * 0.03)
      for (let i = 0; i < 3; i++) {
        const pts = []
        const y0 = H * (0.16 + i * 0.07)
        for (let j = 0; j <= 7; j++) pts.push([lerp(-40, W + 40, j / 7), y0 + Math.sin(j * 1.1 + i * 2) * H * 0.05 + c.R(-12, 12)])
        const d = smooth(pts) + ` L${W + 40},${f(y0 + H * 0.3)} L-40,${f(y0 + H * 0.34)}Z`
        s += path(d, lin(c, [[['#7df0c2', '#86c8ff', '#c79bff'][i], 0.55], [['#7df0c2', '#86c8ff', '#c79bff'][i], 0]]), `filter="${bl}" opacity="0.8"`)
      }
    }
    s += sun(c, sx, H * (o.aurora ? 0.14 : 0.25), M * (night ? 0.06 : 0.09), pal.glow, 4, night ? 0.36 : 0.7)
    let last = null
    for (let i = 0; i < 3; i++) {
      const t = i / 2
      const base = H * lerp(c.wide ? 0.66 : 0.62, 0.9, t)
      const pts = hillPts(c, base, H * 0.09, 5)
      s += path(hill(c, pts), mix(pal.far, pal.near, t))
      if (i === 1) last = pts
      if (i < 2) s += mistBand(c, base - H * 0.02, H * 0.12, pal.sky[1], 0.25)
    }
    if (o.cabin && last) {
      const x = W * (c.wide ? 0.5 : 0.3)
      const y = yAt(last, x) + 6 * k
      const col = night ? '#0d1226' : '#3b4656'
      s += rect(x - 24 * k, y - 26 * k, 48 * k, 28 * k, col)
      s += path(`M${f(x - 32 * k)},${f(y - 26 * k)} L${f(x)},${f(y - 52 * k)} L${f(x + 32 * k)},${f(y - 26 * k)}Z`, night ? '#e9eef8' : '#ffffff')
      s += rect(x + 12 * k, y - 50 * k, 6 * k, 14 * k, col)
      s += rect(x - 8 * k, y - 18 * k, 12 * k, 12 * k, pal.accent)
      s += circ(x - 2 * k, y - 12 * k, 34 * k, rad(c, [[pal.accent, 0.55], [pal.accent, 0]]))
      const sm = blur(c, 5 * k)
      for (let i = 0; i < 4; i++) s += circ(x + 15 * k + i * 7 * k, y - 60 * k - i * 17 * k, (6 + i * 3.4) * k, '#ffffff', `opacity="${0.4 - i * 0.08}" filter="${sm}"`)
    }
    if (o.tree && last) {
      const x = W * (c.wide ? 0.8 : 0.7)
      const y = yAt(last, x) + 4 * k
      const col = '#3b4656'
      s += line(x, y, x - 3 * k, y - 96 * k, col, 3.2 * k)
      const br = [
        [-0.3, 0.45, -30, -34],
        [-0.2, 0.62, 28, -30],
        [-1.6, 0.8, -22, -24],
        [-2.4, 0.9, 16, -20],
      ]
      for (const [dx, at, bx, by] of br) s += line(x + dx * k, y - 96 * k * at, x + dx * k + bx * k, y - 96 * k * at + by * k, col, 1.8 * k)
    }
    for (let i = 0; i < (c.wide ? 240 : 130); i++) s += circ(c.R(0, W), c.R(0, H), c.R(0.8, 2.8) * k, '#ffffff', `opacity="${f(c.R(0.25, 0.95))}"`)
    return s
  },

  // 公路 / 铁轨，一点透视
  road(c) {
    const { W, H, M, pal, o } = c
    const k = M / 600
    const hz = H * (c.wide ? 0.6 : 0.57)
    const vx = W * c.fx
    let s = sky(c, hz + 2)
    if (pal.sky[0] < '#2') s += stars(c, c.wide ? 110 : 60, '#fff', 0.5)
    s += sun(c, vx, hz - M * 0.02, M * 0.15, pal.glow, 3.2, 0.6)
    s += path(closeDown(c, ridgePts(c, hz + 4, H * 0.06, 0.5, 3)), mix(pal.far, pal.near, 0.35))
    s += rect(0, hz, W, H - hz, lin(c, [mix(pal.far, pal.near, 0.55), pal.near]))
    const spread = W * (c.wide ? 0.3 : 0.5)
    const roadCol = mix(pal.near, '#000000', 0.35)
    if (!o.rails) {
      s += path(`M${f(vx - 3 * k)},${f(hz)} L${f(vx + 3 * k)},${f(hz)} L${f(vx + spread)},${H} L${f(vx - spread)},${H}Z`, roadCol)
      for (let i = 0; i < 9; i++) {
        const t0 = Math.pow(i / 9, 2.1)
        const t1 = Math.pow((i + 0.5) / 9, 2.1)
        const y0 = lerp(hz, H, t0)
        const y1 = lerp(hz, H, t1)
        const w0 = lerp(0.6, 9, t0) * k
        const w1 = lerp(0.6, 9, t1) * k
        s += path(`M${f(vx - w0)},${f(y0)} L${f(vx + w0)},${f(y0)} L${f(vx + w1)},${f(y1)} L${f(vx - w1)},${f(y1)}Z`, pal.glow, 'opacity="0.85"')
      }
      for (const side of [-1, 1]) s += line(vx, hz, vx + side * spread, H, pal.glow, 1.6 * k, 'opacity="0.25"')
    } else {
      for (let i = 0; i < 26; i++) {
        const t = Math.pow(i / 26, 2.2)
        const y = lerp(hz, H, t)
        const half = lerp(2, spread * 0.92, t)
        s += rect(vx - half, y, half * 2, lerp(1, 14, t) * k, roadCol)
      }
      for (const side of [-1, 1]) {
        s += path(`M${f(vx + side * 1.5 * k)},${f(hz)} L${f(vx + side * spread * 0.66)},${H} L${f(vx + side * spread * 0.74)},${H}Z`, pal.glow, 'opacity="0.8"')
      }
    }
    // 电线杆
    for (let i = 1; i <= 6; i++) {
      const t = Math.pow(i / 6.5, 1.9)
      const x = vx - lerp(8 * k, spread * 1.5, t)
      const y = lerp(hz, H, t)
      const h = lerp(8, 240, t) * k
      s += line(x, y, x, y - h, roadCol, lerp(0.8, 5.5, t) * k)
      s += line(x - h * 0.12, y - h * 0.9, x + h * 0.12, y - h * 0.9, roadCol, lerp(0.6, 4, t) * k)
    }
    return s
  },

  // 九重宫门
  gates(c) {
    const { W, H, M, pal } = c
    const cx = W * c.fx
    const cy = H * (c.wide ? 0.56 : 0.6)
    let s = rect(0, 0, W, H, pal.near)
    const n = 9
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1)
      const sc = Math.pow(1 - t, 1.25) * 0.92 + 0.08
      const w = M * (c.wide ? 1.9 : 1.02) * sc
      const h = H * (c.wide ? 1.3 : 1.02) * sc
      const col = mix(pal.near, pal.far, Math.pow(t, 1.4))
      s += rect(cx - w / 2, cy - h * 0.62, w, h, col, `rx="${f(w * 0.04)}"`)
      // 门楣
      s += rect(cx - w / 2 - w * 0.03, cy - h * 0.62, w * 1.06, h * 0.035, mix(col, pal.glow, 0.16))
    }
    const iw = M * (c.wide ? 1.9 : 1.02) * 0.08
    const ih = H * (c.wide ? 1.3 : 1.02) * 0.08
    s += rect(cx - iw / 2, cy - ih * 0.62, iw, ih, pal.glow)
    s += circ(cx, cy, M * 0.42, rad(c, [[pal.glow, 0.55], [pal.glow, 0.12, 0.5], [pal.glow, 0]]))
    s += figure(cx, cy + ih * 0.38, ih * 0.5, pal.near)
    // 地面透视线
    for (let i = -5; i <= 5; i++) s += line(cx + i * iw * 0.1, cy + ih * 0.38, cx + i * W * 0.22, H, pal.glow, 1, 'opacity="0.1"')
    return s
  },

  // 深海与声呐
  deep(c) {
    const { W, H, M, pal } = c
    const k = M / 600
    const sx = W * c.fx
    const sy = H * (c.wide ? 0.56 : 0.56)
    let s = sky(c)
    for (let i = 0; i < 5; i++) {
      const x = W * (0.1 + i * 0.2) + c.R(-40, 40)
      s += path(`M${f(x - 14 * k)},0 L${f(x + 30 * k)},0 L${f(x + 190 * k)},${H} L${f(x - 110 * k)},${H}Z`, lin(c, [[pal.glow, 0.16], [pal.glow, 0]]))
    }
    for (let i = 0; i < 7; i++) s += circ(sx, sy, M * (0.07 + i * 0.085), 'none', `stroke="${pal.glow}" stroke-opacity="${f(0.62 - i * 0.085)}" stroke-width="${f(1.6 * k)}"`)
    const col = '#02080d'
    s += rect(sx - 30 * k, sy - 7 * k, 60 * k, 14 * k, col, `rx="${f(7 * k)}"`)
    s += rect(sx - 8 * k, sy - 15 * k, 15 * k, 10 * k, col, `rx="${f(2 * k)}"`)
    s += path(`M${f(sx - 30 * k)},${f(sy)} L${f(sx - 44 * k)},${f(sy - 9 * k)} L${f(sx - 44 * k)},${f(sy + 9 * k)}Z`, col)
    s += path(`M${f(sx + 28 * k)},${f(sy)} L${f(sx + 190 * k)},${f(sy - 50 * k)} L${f(sx + 190 * k)},${f(sy + 62 * k)}Z`, lin(c, [[pal.accent, 0.5], [pal.accent, 0]], 0, 0, 1, 0))
    s += circ(sx + 26 * k, sy, 3 * k, pal.accent)
    for (let i = 0; i < (c.wide ? 110 : 60); i++) s += circ(c.R(0, W), c.R(0, H), c.R(0.8, 2.4) * k, pal.glow, `opacity="${f(c.R(0.12, 0.5))}"`)
    s += path(closeDown(c, ridgePts(c, H * 0.94, H * 0.08, 0.6, 5)), pal.near)
    return s
  },

  // 舞台追光
  spot(c) {
    const { W, H, M, pal } = c
    const k = M / 600
    const sx = W * c.fx
    const fy = H * (c.wide ? 0.82 : 0.66)
    const [curtain, warm, cream, curtainDark] = pal.colors
    let s = rect(0, 0, W, H, pal.bg)
    const stripeW = (c.wide ? 46 : 34) * k
    const nStripe = c.wide ? 9 : 4
    for (const side of [0, 1]) {
      for (let i = 0; i < nStripe; i++) {
        const x = side ? W - (i + 1) * stripeW : i * stripeW
        s += rect(x, 0, stripeW + 1, H, lin(c, [i % 2 ? curtain : curtainDark, mix(i % 2 ? curtain : curtainDark, pal.bg, 0.7)]))
      }
    }
    s += path(`M${f(sx - 16 * k)},0 L${f(sx + 16 * k)},0 L${f(sx + 190 * k)},${f(fy)} L${f(sx - 190 * k)},${f(fy)}Z`, lin(c, [[warm, 0.58], [warm, 0.12]]))
    s += `<ellipse cx="${f(sx)}" cy="${f(fy)}" rx="${f(190 * k)}" ry="${f(26 * k)}" fill="${warm}" opacity="0.72"/>`
    const ink = '#0c0710'
    s += `<ellipse cx="${f(sx)}" cy="${f(fy)}" rx="${f(30 * k)}" ry="${f(6 * k)}" fill="${ink}"/>`
    s += line(sx, fy, sx, fy - 150 * k, ink, 5 * k)
    s += line(sx, fy - 150 * k, sx + 16 * k, fy - 168 * k, ink, 5 * k)
    s += `<rect x="${f(sx + 6 * k)}" y="${f(fy - 196 * k)}" width="${f(20 * k)}" height="${f(36 * k)}" rx="${f(10 * k)}" fill="${ink}" transform="rotate(32 ${f(sx + 16 * k)} ${f(fy - 178 * k)})"/>`
    s += rect(0, fy + 26 * k, W, H, lin(c, [[pal.bg, 0], [pal.bg, 1]], 0, 0, 0, 0.4), '')
    void cream
    return s
  },

  // 航拍河流与等高线
  river(c) {
    const { W, H, M, pal } = c
    const k = M / 600
    let s = rect(0, 0, W, H, lin(c, [pal.near, mix(pal.sky[1], pal.near, 0.5)], 0, 0, 1, 1))
    for (let i = 0; i < (c.wide ? 22 : 26); i++) {
      const y0 = (H / (c.wide ? 20 : 24)) * i + c.R(-10, 10)
      const pts = []
      const ph = c.R(0, 6.28)
      for (let j = 0; j <= 8; j++) pts.push([lerp(-30, W + 30, j / 8), y0 + Math.sin(j * 0.9 + ph + i * 0.35) * H * 0.035])
      s += `<path d="${smooth(pts)}" fill="none" stroke="${pal.far}" stroke-opacity="${f(c.R(0.12, 0.34))}" stroke-width="${f(1.2 * k)}"/>`
    }
    const cx = W * c.fx
    const main = []
    const ph = c.R(0, 6.28)
    for (let j = 0; j <= 9; j++) {
      const t = j / 9
      main.push([cx + Math.sin(t * 7.2 + ph) * W * (c.wide ? 0.09 : 0.2) * (0.5 + t * 0.6), lerp(-40, H + 40, t)])
    }
    const d = smooth(main)
    s += `<path d="${d}" fill="none" stroke="${pal.glow}" stroke-opacity="0.22" stroke-width="${f(64 * k)}" stroke-linecap="round" filter="${blur(c, 16 * k)}"/>`
    s += `<path d="${d}" fill="none" stroke="${lin(c, [pal.glow, pal.accent], 0, 0, 0, H, true)}" stroke-width="${f(15 * k)}" stroke-linecap="round"/>`
    for (let i = 0; i < 4; i++) {
      const at = main[2 + i * 2]
      const side = i % 2 ? 1 : -1
      const br = [at, [at[0] + side * 70 * k, at[1] - 50 * k], [at[0] + side * 150 * k, at[1] - 70 * k + c.R(-30, 30)], [at[0] + side * (240 + c.R(0, 120)) * k, at[1] - 150 * k]]
      s += `<path d="${smooth(br)}" fill="none" stroke="${pal.glow}" stroke-opacity="0.75" stroke-width="${f((5.5 - i * 0.7) * k)}" stroke-linecap="round"/>`
    }
    return s
  },

  // 七个圆点，最后一个不一样
  dots(c) {
    const { W, H, M, pal } = c
    let s = sky(c)
    s += circ(W * 0.5, H * 0.4, M * 0.9, rad(c, [[pal.far, 0.6], [pal.far, 0]]))
    const r = M * (c.wide ? 0.058 : 0.085)
    const pos = []
    if (c.wide) {
      for (let i = 0; i < 7; i++) pos.push([W * 0.42 + i * r * 2.9, H * 0.48])
    } else {
      for (let i = 0; i < 4; i++) pos.push([W * 0.5 + (i - 1.5) * r * 2.75, H * 0.3])
      for (let i = 0; i < 3; i++) pos.push([W * 0.5 + (i - 1.5) * r * 2.75, H * 0.3 + r * 2.75])
    }
    pos.forEach(([x, y], i) => {
      if (i === 6) {
        s += circ(x, y, r * 3.4, rad(c, [[pal.accent, 0.55], [pal.accent, 0]]))
        s += circ(x, y, r, pal.accent)
      } else {
        s += circ(x, y, r, lin(c, [mix(pal.far, '#ffffff', 0.22), pal.far]))
      }
    })
    return s
  },
}

// ───────────────────────── 片名排字（只在竖版海报上）─────────────────────────
function glyphPath(font, ch, x, y, size) {
  const g = font.charToGlyph(ch)
  if (!g || g.index === 0) throw new Error(`字体里没有这个字：${ch}`)
  return { d: g.getPath(x, y, size).toPathData(1), adv: (g.advanceWidth / font.unitsPerEm) * size }
}
function textRun(font, text, x, y, size, tracking = 0) {
  let d = ''
  let cx = x
  for (const ch of text) {
    if (ch === ' ') {
      cx += size * 0.3 + tracking
      continue
    }
    const g = glyphPath(font, ch, cx, y, size)
    d += g.d
    cx += g.adv + tracking
  }
  return { d, width: cx - x - tracking }
}
function lettering(c, item, o) {
  const { W, H, pal } = c
  const chars = [...item.title]
  const n = chars.length
  const en = `${item.originalTitle.toUpperCase()}`
  let s = ''
  const subY = H - 54
  if ((o.layout ?? 'v') === 'v') {
    const size = n <= 2 ? 150 : n === 3 ? 128 : n === 4 ? 108 : n === 5 ? 92 : n === 6 ? 78 : 68
    const x = W - 58 - size
    let y = 70 + size * 0.86
    let d = ''
    for (const ch of chars) {
      d += glyphPath(fontZh, ch, x, y, size).d
      y += size * 1.07
    }
    s += path(d, pal.title)
  } else {
    const size = Math.min(128, (W - 104) / n)
    const run = textRun(fontZh, item.title, 52, H - 122, size, size * 0.02)
    s += path(run.d, pal.sub)
  }
  s += rect(52, subY - 30, 30, 2, pal.sub, 'opacity="0.9"')
  let enSize = 15
  let run = textRun(fontEn, en, 52, subY, enSize, enSize * 0.3)
  if (run.width > W - 190) {
    enSize = (15 * (W - 190)) / run.width
    run = textRun(fontEn, en, 52, subY, enSize, enSize * 0.3)
  }
  s += path(run.d, pal.sub, 'opacity="0.92"')
  const yr = textRun(fontEn, String(item.year), 0, subY, 15, 15 * 0.2)
  s += path(textRun(fontEn, String(item.year), W - 52 - yr.width, subY, 15, 15 * 0.2).d, pal.sub, 'opacity="0.7"')
  return s
}

// ───────────────────────── 输出 ─────────────────────────
function buildSvg(item, wide) {
  const o = ART[item.id]
  if (!o) throw new Error(`美术指导表缺少：${item.id}`)
  const [W, H] = wide ? [1600, 900] : [600, 900]
  const c = makeCtx(W, H, hashSeed(item.id) + (wide ? 97 : 0), PAL[o.pal], o, wide)
  let inner = SCENES[o.scene](c)
  if (!wide) {
    // 底部压暗一点，保证英文副题可读（浅色调色板不压）
    const base = c.pal.near ?? c.pal.ink ?? c.pal.bg
    if (o.scene !== 'geo' && o.scene !== 'ink') inner += rect(0, H * 0.74, W, H * 0.26, lin(c, [[base, 0], [base, 0.5]]))
    inner += lettering(c, item, o)
    if (o.scene === 'ink') {
      // 朱印
      const n = [...item.title].length
      const size = n <= 2 ? 150 : n === 3 ? 128 : n === 4 ? 108 : n === 5 ? 92 : 78
      inner += rect(W - 58 - size / 2 - 17, 70 + n * size * 1.07 + 14, 34, 34, c.pal.accent, 'rx="5"')
    }
  }
  inner += rect(0, 0, W, H, rad(c, [['#000000', 0], ['#000000', 0, 0.55], ['#000000', wide ? 0.3 : 0.26]], 0.5, 0.5, 0.8))
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs>${c.defs.join('')}</defs>${inner}</svg>`
}

const grainCache = new Map()
function grain(W, H) {
  const key = `${W}x${H}`
  if (grainCache.has(key)) return grainCache.get(key)
  const rng = mulberry32(20261115)
  const buf = Buffer.alloc(W * H * 4)
  for (let i = 0; i < W * H; i++) {
    // 近似高斯：三个均匀分布相加
    const g = (rng() + rng() + rng() - 1.5) / 1.5
    const v = Math.max(0, Math.min(255, Math.round(128 + g * 30)))
    buf[i * 4] = buf[i * 4 + 1] = buf[i * 4 + 2] = v
    buf[i * 4 + 3] = 255
  }
  grainCache.set(key, buf)
  return buf
}
async function render(item, wide, file) {
  const svg = buildSvg(item, wide)
  const [W, H] = wide ? [1600, 900] : [600, 900]
  await sharp(Buffer.from(svg))
    .composite([{ input: grain(W, H), raw: { width: W, height: H, channels: 4 }, blend: 'soft-light' }])
    .webp({ quality: wide ? 78 : 84, effort: 5 })
    .toFile(file)
}
async function contactSheet(files, tw, th, cols, out) {
  const rows = Math.ceil(files.length / cols)
  const gap = 10
  const thumbs = await Promise.all(files.map((f2) => sharp(f2).resize(tw, th).png().toBuffer()))
  await sharp({ create: { width: cols * (tw + gap) + gap, height: rows * (th + gap) + gap, channels: 3, background: '#0e0d0b' } })
    .composite(thumbs.map((input, i) => ({ input, left: gap + (i % cols) * (tw + gap), top: gap + Math.floor(i / cols) * (th + gap) })))
    .png()
    .toFile(out)
}

const catalog = JSON.parse(readFileSync(join(ROOT, 'mock/catalog.json'), 'utf8'))
const only = process.argv.slice(2)
const items = catalog.items.filter((it) => !only.length || only.includes(it.id))
for (const dir of ['art/posters', 'art/backdrops', 'tools/.out']) mkdirSync(join(ROOT, dir), { recursive: true })

const posters = []
const backdrops = []
for (const item of items) {
  if (item.poster) {
    const file = join(ROOT, item.poster)
    await render(item, false, file)
    posters.push(file)
  }
  if (item.backdrop) {
    const file = join(ROOT, item.backdrop)
    await render(item, true, file)
    backdrops.push(file)
  }
}
if (posters.length) await contactSheet(posters, 200, 300, Math.min(11, posters.length), join(ROOT, 'tools/.out/posters.png'))
if (backdrops.length) await contactSheet(backdrops, 384, 216, Math.min(6, backdrops.length), join(ROOT, 'tools/.out/backdrops.png'))
console.log(`海报 ${posters.length} 张，剧照 ${backdrops.length} 张 → design/art/`)
