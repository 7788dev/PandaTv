// 把 design/brand/app-icon.svg 栅格化成 1024×1024 的 PNG：node design/tools/build-brand.mjs
// 之后在项目根执行 `pnpm tauri icon design/brand/app-icon.png` 生成各平台图标。
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const svg = readFileSync(join(ROOT, 'brand/app-icon.svg'))
await sharp(svg, { density: 72 }).resize(1024, 1024).png({ compressionLevel: 9 }).toFile(join(ROOT, 'brand/app-icon.png'))
await sharp(readFileSync(join(ROOT, 'brand/logo-mark.svg')), { density: 288 }).resize(256, 256).png().toFile(join(ROOT, 'brand/logo-mark.png'))
console.log('brand/app-icon.png (1024) · brand/logo-mark.png (256)')
