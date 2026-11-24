/** Count only time during which startup is wanted; a paused load keeps its remaining budget. */
export class StartupWatchdog {
  private remaining: number
  private enabled = false
  private finished = false
  private startedAt = 0
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(timeoutMs: number, private readonly onTimeout: () => void, private readonly now = () => performance.now()) {
    this.remaining = timeoutMs
  }

  setEnabled(enabled: boolean) {
    if (this.finished || this.enabled === enabled) return
    if (this.enabled) {
      this.remaining = Math.max(0, this.remaining - Math.max(0, this.now() - this.startedAt))
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.enabled = enabled
    if (!enabled) return
    this.startedAt = this.now()
    this.timer = setTimeout(() => { this.finish(); this.onTimeout() }, this.remaining)
  }

  finish() {
    clearTimeout(this.timer)
    this.timer = undefined
    this.enabled = false
    this.finished = true
  }
}
