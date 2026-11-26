// 规则配置：所有判定参数从外部注入，纯规则函数不得读取系统时钟或写死判定值。
// 标定纪律：null 表示「尚未离线标定」，加载时必须由外部注入；resolve* 会在缺失时抛错。

export interface HealthWeights {
  readonly availability: number
  readonly stability: number
  readonly speed: number
  readonly quality: number
}

export interface HealthConfig {
  readonly basisVersion: string
  readonly decayVersion: string
  /** 评分半衰期（天）。需离线标定 */
  readonly halfLifeDays: number | null
  /** 无观测时的中性先验分。需离线标定 */
  readonly baseline: number | null
  /** 起播耗时达到该值记 0 分（秒）。需离线标定 */
  readonly slowStartupSec: number | null
  /** 卡顿率分母下限（秒）。需离线标定 */
  readonly playFloorSec: number | null
  /** 作品级修正限幅。需离线标定 */
  readonly workDeltaMax: number | null
  readonly weights: HealthWeights | null
}

export interface ResolvedHealthConfig {
  readonly basisVersion: string
  readonly decayVersion: string
  readonly halfLifeDays: number
  readonly baseline: number
  readonly slowStartupSec: number
  readonly playFloorSec: number
  readonly workDeltaMax: number
  readonly weights: HealthWeights
}

export interface BufferConfig {
  /** 起播目标缓冲（秒）。spec 4.2.6 默认 4 */
  readonly startupTargetSec: number | null
  /** 起播判定窗口（秒）。spec 4.2.6 默认 3 */
  readonly startupWindowSec: number | null
  /** 播放中低水位（秒）。spec 4.2.6 默认 6 */
  readonly playingLowSec: number | null
  /** 播放中回升判定窗口（秒）。spec 4.2.6 默认 5 */
  readonly playingRiseWindowSec: number | null
  /** seek 后低水位（秒）。spec 4.2.6 默认 3 */
  readonly seekLowSec: number | null
  /** 播放位置连续不前进判据（秒）。spec 5.2.1.1 默认 20 */
  readonly stallPositionSec: number | null
}

export interface ResolvedBufferConfig {
  readonly startupTargetSec: number
  readonly startupWindowSec: number
  readonly playingLowSec: number
  readonly playingRiseWindowSec: number
  readonly seekLowSec: number
  readonly stallPositionSec: number
}

export interface BudgetConfig {
  /** 同集自动切换上限。spec 4.2.1 上限 3，配置只能收紧 */
  readonly maxSwitchesPerEpisode: number | null
  /** 自动切换最小间隔（秒）。spec 4.2.2 默认 30 */
  readonly minIntervalSec: number | null
  /** 失败源冷却（秒）。spec 5.2.1.6 默认 300 */
  readonly failedSourceCooldownSec: number | null
}

export interface ResolvedBudgetConfig {
  readonly maxSwitchesPerEpisode: number
  readonly minIntervalSec: number
  readonly failedSourceCooldownSec: number
}

export interface AlignmentConfig {
  /** 判定基准版本，变更即让旧结论失效 */
  readonly basisVersion: string
  /** 时长相对偏差上限（比例）。需离线标定 */
  readonly ratioTolerance: number | null
  /** 时长绝对偏差上限（秒）。需离线标定 */
  readonly absoluteToleranceSec: number | null
  /** 同源历史离散度上限（占中位数比例）。需离线标定 */
  readonly historyConsistencyRatio: number | null
  /** 同作品集间离群系数。需离线标定 */
  readonly workSpreadFactor: number | null
  /** 帧校验窗口半径（秒）。需离线标定 */
  readonly windowSeconds: number | null
  /** 帧采样点上限。spec 4.1.5 上限 5，配置只能收紧 */
  readonly sampleLimit: number | null
  /** 帧校验总预算（毫秒）。spec 4.1.5 上限 1200，配置只能收紧 */
  readonly frameBudgetMs: number | null
  /** 帧相似度阈值。需离线标定 */
  readonly similarityThreshold: number | null
  /** 偏移缓存有效期（天）。spec 建议 7 */
  readonly offsetTtlDays: number | null
  /** 接管余量系数。需离线标定 */
  readonly takeoverHeadroomFactor: number | null
}

export interface ResolvedAlignmentConfig {
  readonly basisVersion: string
  readonly ratioTolerance: number
  readonly absoluteToleranceSec: number
  readonly historyConsistencyRatio: number
  readonly workSpreadFactor: number
  readonly windowSeconds: number
  readonly sampleLimit: number
  readonly frameBudgetMs: number
  readonly similarityThreshold: number
  readonly offsetTtlDays: number
  readonly takeoverHeadroomFactor: number
}

export const DEFAULT_HEALTH_CONFIG: HealthConfig = {
  basisVersion: 'uncalibrated',
  decayVersion: '1',
  halfLifeDays: null,
  baseline: null,
  slowStartupSec: null,
  playFloorSec: null,
  workDeltaMax: null,
  weights: null,
}

export const DEFAULT_BUFFER_CONFIG: BufferConfig = {
  startupTargetSec: 4,
  startupWindowSec: 3,
  playingLowSec: 6,
  playingRiseWindowSec: 5,
  seekLowSec: 3,
  stallPositionSec: 20,
}

export const DEFAULT_BUDGET_CONFIG: BudgetConfig = {
  maxSwitchesPerEpisode: 3,
  minIntervalSec: 30,
  failedSourceCooldownSec: 300,
}

export const DEFAULT_ALIGNMENT_CONFIG: AlignmentConfig = {
  basisVersion: 'uncalibrated',
  ratioTolerance: null,
  absoluteToleranceSec: null,
  historyConsistencyRatio: null,
  workSpreadFactor: null,
  windowSeconds: null,
  sampleLimit: 5,
  frameBudgetMs: 1200,
  similarityThreshold: null,
  offsetTtlDays: 7,
  takeoverHeadroomFactor: null,
}

function missing(field: string): never {
  throw new Error(`rule-config-uncalibrated:${field}`)
}

function need(value: number | null, field: string): number {
  if (value === null || !Number.isFinite(value)) missing(field)
  return value
}

function needPositive(value: number | null, field: string): number {
  const n = need(value, field)
  if (n <= 0) throw new Error(`rule-config-invalid:${field}`)
  return n
}

function needRatio(value: number | null, field: string): number {
  const n = need(value, field)
  if (n < 0) throw new Error(`rule-config-invalid:${field}`)
  return n
}

function resolveWeights(weights: HealthWeights | null): HealthWeights {
  if (weights === null) missing('health.weights')
  const out = {
    availability: needRatio(weights.availability, 'health.weights.availability'),
    stability: needRatio(weights.stability, 'health.weights.stability'),
    speed: needRatio(weights.speed, 'health.weights.speed'),
    quality: needRatio(weights.quality, 'health.weights.quality'),
  }
  const sum = out.availability + out.stability + out.speed + out.quality
  if (Math.abs(sum - 1) > 1e-6) throw new Error('rule-config-invalid:health.weights.sum')
  return out
}

export function resolveHealthConfig(config: HealthConfig): ResolvedHealthConfig {
  return {
    basisVersion: config.basisVersion,
    decayVersion: config.decayVersion,
    halfLifeDays: needPositive(config.halfLifeDays, 'health.halfLifeDays'),
    baseline: needRatio(config.baseline, 'health.baseline'),
    slowStartupSec: needPositive(config.slowStartupSec, 'health.slowStartupSec'),
    playFloorSec: needPositive(config.playFloorSec, 'health.playFloorSec'),
    workDeltaMax: needRatio(config.workDeltaMax, 'health.workDeltaMax'),
    weights: resolveWeights(config.weights),
  }
}

export function resolveBufferConfig(config: BufferConfig): ResolvedBufferConfig {
  return {
    startupTargetSec: needPositive(config.startupTargetSec, 'buffer.startupTargetSec'),
    startupWindowSec: needPositive(config.startupWindowSec, 'buffer.startupWindowSec'),
    playingLowSec: needPositive(config.playingLowSec, 'buffer.playingLowSec'),
    playingRiseWindowSec: needPositive(config.playingRiseWindowSec, 'buffer.playingRiseWindowSec'),
    seekLowSec: needPositive(config.seekLowSec, 'buffer.seekLowSec'),
    stallPositionSec: needPositive(config.stallPositionSec, 'buffer.stallPositionSec'),
  }
}

export function resolveBudgetConfig(config: BudgetConfig): ResolvedBudgetConfig {
  const switches = needPositive(config.maxSwitchesPerEpisode, 'budget.maxSwitchesPerEpisode')
  const interval = needPositive(config.minIntervalSec, 'budget.minIntervalSec')
  const cooldown = needPositive(config.failedSourceCooldownSec, 'budget.failedSourceCooldownSec')
  if (switches > 3) throw new Error('rule-config-invalid:budget.maxSwitchesPerEpisode')
  if (interval < 30) throw new Error('rule-config-invalid:budget.minIntervalSec')
  if (cooldown < 300) throw new Error('rule-config-invalid:budget.failedSourceCooldownSec')
  return {
    maxSwitchesPerEpisode: switches,
    minIntervalSec: interval,
    failedSourceCooldownSec: cooldown,
  }
}

export function resolveAlignmentConfig(config: AlignmentConfig): ResolvedAlignmentConfig {
  const sampleLimit = needPositive(config.sampleLimit, 'alignment.sampleLimit')
  const frameBudgetMs = needPositive(config.frameBudgetMs, 'alignment.frameBudgetMs')
  if (sampleLimit > 5) throw new Error('rule-config-invalid:alignment.sampleLimit')
  if (frameBudgetMs > 1200) throw new Error('rule-config-invalid:alignment.frameBudgetMs')
  return {
    basisVersion: config.basisVersion,
    ratioTolerance: needRatio(config.ratioTolerance, 'alignment.ratioTolerance'),
    absoluteToleranceSec: needRatio(config.absoluteToleranceSec, 'alignment.absoluteToleranceSec'),
    historyConsistencyRatio: needRatio(config.historyConsistencyRatio, 'alignment.historyConsistencyRatio'),
    workSpreadFactor: needRatio(config.workSpreadFactor, 'alignment.workSpreadFactor'),
    windowSeconds: needPositive(config.windowSeconds, 'alignment.windowSeconds'),
    sampleLimit,
    frameBudgetMs,
    similarityThreshold: needRatio(config.similarityThreshold, 'alignment.similarityThreshold'),
    offsetTtlDays: needPositive(config.offsetTtlDays, 'alignment.offsetTtlDays'),
    takeoverHeadroomFactor: needPositive(config.takeoverHeadroomFactor, 'alignment.takeoverHeadroomFactor'),
  }
}