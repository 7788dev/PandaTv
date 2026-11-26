// 行为常量：写在脚本里的数字都在这里，界面代码里不要再出现第二份。
// 写在样式里的数字（时长、缓动、尺寸、轮播间隔）在 src/renderer/styles/tokens.css，不在这里。

import type { Settings } from './types'

// ───────────────────────── 可选项 ─────────────────────────

/** 清晰度，从高到低 */
export const QUALITIES = ['4K', '1080P', '720P', '480P'] as const

/** 倍速 */
export const SPEEDS = [0.75, 1, 1.25, 1.5, 2] as const

/** 第一次启动时的设置 */
export const DEFAULT_SETTINGS: Settings = {
  autoNext: true,
  skipIntro: true,
  quality: '1080P',
  speed: 1,
  volume: 0.8,
  muted: false,
}

// ───────────────────────── 列表 ─────────────────────────

/** 选集超过这个数就分段显示（1-50 / 51-100 …） */
export const EPISODE_RANGE_SIZE = 50

// ───────────────────────── 页面 ─────────────────────────

/** 页面滚动超过多少像素后，顶栏换成实底（给 .topbar 加 data-scrolled） */
export const SCROLLED_PX = 8
/** 横向栏目离两端多近算「到头了」（隐藏对应的翻页箭头） */
export const SHELF_EDGE_PX = 4

// ───────────────────────── 浮层 ─────────────────────────

/** 浮层与触发元素的距离，也是浮层与窗口边缘的最小距离 */
export const POPUP_OFFSET_PX = 8
/** 鼠标停多久后出现提示 */
export const TOOLTIP_DELAY_MS = 500
/** 轻提示停留多久 */
export const TOAST_MS = 2400
/** 带「撤销」的轻提示停留多久 */
export const TOAST_ACTION_MS = 4000

// ───────────────────────── 播放 ─────────────────────────

/** 进度超过这个比例算看完 */
export const FINISHED_RATIO = 0.95
/** 鼠标静止多久后隐藏控件 */
export const PLAYER_IDLE_MS = 2500
/** 距离结束还有多少秒时出现「即将播放」 */
export const UPNEXT_SECONDS = 10
/** 左右方向键一次快进 / 快退多少秒 */
export const SEEK_STEP_SECONDS = 10
/** 上下方向键一次调多少音量 */
export const VOLUME_STEP = 0.05
/** 音量为 0 时点「取消静音」恢复到多少 */
export const UNMUTE_VOLUME = 0.5
/** 快进、音量的瞬时反馈停留多久 */
export const OSD_MS = 900
/** 「跳过片头」在片头开始后、结束前各留出多少秒不显示 */
export const SKIP_EDGE_SECONDS = 2
/** 播放中每隔多少秒保存一次进度 */
export const HISTORY_SAVE_SECONDS = 5
