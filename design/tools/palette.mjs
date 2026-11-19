// 配色推导与对比度验证：node design/tools/palette.mjs
// 色值在 OKLCH 里定义（明度均匀，好调），这里换算成 sRGB hex，并按 WCAG 2.x 计算对比度。
// tokens.css 里的原始色值以本脚本输出为准；改色先改这里，再同步 tokens.css。

const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const toGamma = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)

export function oklch(L, C, H) {
  const h = (H * Math.PI) / 180
  const a = C * Math.cos(h)
  const b = C * Math.sin(h)
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  const rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
  const clipped = rgb.some((v) => v < -0.0005 || v > 1.0005)
  const out = rgb.map((v) => Math.round(Math.min(1, Math.max(0, toGamma(Math.min(1, Math.max(0, v))))) * 255))
  return { rgb: out, hex: '#' + out.map((v) => v.toString(16).padStart(2, '0')).join(''), clipped }
}

const lum = ([r, g, b]) => 0.2126 * toLinear(r / 255) + 0.7152 * toLinear(g / 255) + 0.0722 * toLinear(b / 255)
export const contrast = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
// 前景 fg 以 alpha 叠在 bg 上的实际颜色
export const over = (fg, bg, alpha) => fg.map((v, i) => Math.round(v * alpha + bg[i] * (1 - alpha)))

// ───────────── 原始色 ─────────────
const NEUTRAL_H = 80 // 暖灰：墨与纸
const P = {
  // 墨（背景与表面）
  'ink-950': [0.158, 0.004, NEUTRAL_H],
  'ink-900': [0.192, 0.005, NEUTRAL_H],
  'ink-850': [0.226, 0.006, NEUTRAL_H],
  'ink-800': [0.262, 0.006, NEUTRAL_H],
  'ink-700': [0.32, 0.007, NEUTRAL_H],
  'ink-600': [0.4, 0.008, NEUTRAL_H],
  // 纸（文字与主按钮）
  'paper-100': [0.94, 0.012, NEUTRAL_H],
  'paper-50': [0.985, 0.006, NEUTRAL_H],
  // 竹（唯一强调色）
  'bamboo-300': [0.87, 0.085, 158],
  'bamboo-400': [0.8, 0.115, 158],
  'bamboo-500': [0.7, 0.125, 158],
  // 珀（只给评分）
  'amber-400': [0.83, 0.125, 78],
  // 朱（只给危险与错误）
  'cinnabar-400': [0.7, 0.165, 30],
  'cinnabar-500': [0.62, 0.19, 29],
}

const prim = Object.fromEntries(Object.entries(P).map(([k, v]) => [k, oklch(...v)]))

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('palette.mjs')) {
  console.log('── 原始色 ──')
  for (const [k, v] of Object.entries(prim)) {
    console.log(`${k.padEnd(14)} ${v.hex}  rgb(${v.rgb.join(' ')})  oklch(${P[k].join(' ')})${v.clipped ? '  ⚠ 超出 sRGB' : ''}`)
  }

  const bg = prim['ink-950'].rgb
  const surface = prim['ink-900'].rgb
  const raised = prim['ink-850'].rgb
  const paper = prim['paper-100'].rgb
  const rows = [
    ['正文 text      纸 100%', paper, 1, 4.5],
    ['次级 text-2    纸 68%', paper, 0.68, 4.5],
    ['辅助 text-3    纸 48%', paper, 0.48, 3],
    ['禁用 text-4    纸 30%', paper, 0.3, 0],
    ['强调 accent    竹 400', prim['bamboo-400'].rgb, 1, 4.5],
    ['评分 score     珀 400', prim['amber-400'].rgb, 1, 4.5],
    ['危险 danger    朱 400', prim['cinnabar-400'].rgb, 1, 4.5],
  ]
  console.log('\n── 对比度（前景 / 背景）──   要求   bg     surface  raised')
  for (const [name, fg, a, need] of rows) {
    const cells = [bg, surface, raised].map((b) => contrast(over(fg, b, a), b).toFixed(2).padStart(6))
    const ok = [bg, surface, raised].every((b) => contrast(over(fg, b, a), b) >= need)
    console.log(`${name.padEnd(22)} ≥${String(need).padEnd(4)} ${cells.join('  ')}  ${need === 0 ? '—' : ok ? '✓' : '✗'}`)
  }
  console.log('\n── 主按钮 ──')
  console.log('墨字 / 纸底      ', contrast(bg, paper).toFixed(2))
  console.log('墨字 / 竹底      ', contrast(bg, prim['bamboo-400'].rgb).toFixed(2))
  console.log('纸字 / 朱 500 底 ', contrast(prim['paper-50'].rgb, prim['cinnabar-500'].rgb).toFixed(2))
}
