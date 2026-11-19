// 演示数据的入口（只能在 Vite 里用）。
//
//   import { mockSource, mockUser } from '@design/mock/index.ts'
//
// mockSource  实现了 DataSource 的演示数据源，开发阶段直接当数据层用
// mockUser()  演示用的本机初始状态，第一次启动时用它初始化 store
//
// 想看加载、分页、出错状态时，用 createMockSource 自己建一份：
//   createMockSource(catalog, { asset, delay: 1500, pageSize: 6, fail: (op) => op === 'detail' })
// 接入真实接口后，这个文件和 art/ 里的图片就不再需要引用，打包产物里也不会再有它们。

import raw from './catalog.json' with { type: 'json' }
import { createMockSource, createMockUser } from './source.ts'
import type { Catalog } from './source.ts'

// 演示图片：让 Vite 把 art/ 下的图片当作资源处理，得到「路径 → 最终地址」的对照表
const files = import.meta.glob<string>('../art/**/*.webp', { eager: true, query: '?url', import: 'default' })

/** 把 catalog 里的图片路径（art/posters/x.webp）换成最终地址 */
export const asset = (path: string): string | undefined => files[`../${path}`]

// catalog.json 是手写的演示数据，字段与 Catalog 一致；JSON 导入推断不出字面量类型，这里明确指定
export const catalog = raw as unknown as Catalog

export const mockSource = createMockSource(catalog, { asset })

export const mockUser = (now?: number) => createMockUser(catalog, now)

export { createMockSource }
