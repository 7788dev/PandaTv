// 文案的唯一入口。界面上出现的每一个字都从这里取：
//
//   import { t, fmt } from '@design/contract/copy.ts'
//   t.action.play                              → 播放
//   fmt(t.status.remaining, { n: 18 })         → 剩余18分钟
//
// 文案本身在 copy/zh-CN.json。需要新文案时写进 src/copy.extra.ts，不要改这里，也不要在组件里直接写中文。

import zh from '../copy/zh-CN.json' with { type: 'json' }

export const t = zh

/** 把文案里的 {变量} 换成值 */
export const fmt = (template: string, vars: Record<string, string | number> = {}): string =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => String(vars[key] ?? ''))
