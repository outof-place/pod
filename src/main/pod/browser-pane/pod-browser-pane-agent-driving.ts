// Fork-only (Pod): whether an agent drives a pane's page, from its last command until a while after.

// How long after an agent's last command its page still reads as driven.
const AGENT_DRIVING_MS = 3_000

export class PaneAgentDriving {
  private until = 0
  private timer: ReturnType<typeof setTimeout> | null = null

  /** `changed` runs when the page starts or stops reading as driven. */
  constructor(private readonly changed: () => void) {}

  get driving(): boolean {
    return Date.now() < this.until
  }

  noteCommand(): void {
    const wasDriving = this.driving
    this.until = Date.now() + AGENT_DRIVING_MS
    this.dispose()
    this.timer = setTimeout(() => {
      this.timer = null
      this.changed()
    }, AGENT_DRIVING_MS)
    this.timer.unref?.()
    if (!wasDriving) {
      this.changed()
    }
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}
