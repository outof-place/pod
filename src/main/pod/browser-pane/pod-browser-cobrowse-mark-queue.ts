// Fork-only (Pod): a pane page's marks on their way from the user (draft, sent) to the agent that
// takes them, and the agents waiting on `marks --wait` for some.
import { COBROWSE_LIMITS, type CobrowseMark } from '../../../shared/browser-cobrowse-types'
import type { StoredMark } from './pod-browser-cobrowse-anchors'

type Waiter = (marks: CobrowseMark[]) => void

export type MarkTakeOptions = {
  wait: boolean
  timeoutMs: number
  // Every mark, nothing taken: for a copy as Markdown.
  peek: boolean
  signal?: AbortSignal
}

export class CobrowseMarkQueue {
  private stored: StoredMark[] = []
  private readonly waiters = new Set<Waiter>()
  private nextNumber = 1

  // `changed`: what PodNative draws of the marks, or whether an agent waits, changed.
  constructor(private readonly changed: () => void) {}

  get marks(): readonly StoredMark[] {
    return this.stored
  }

  get agentWaiting(): boolean {
    return this.waiters.size > 0
  }

  get idle(): boolean {
    return this.stored.length === 0 && this.waiters.size === 0
  }

  has(markId: string): boolean {
    return this.stored.some((m) => m.mark.id === markId)
  }

  /**
   * The next mark's number, claimed now so marks made at once differ; null when the page holds
   * marksPerPage no agent took yet (the oldest taken one gives way, a draft never does).
   */
  claimNumber(): number | null {
    if (this.stored.length >= COBROWSE_LIMITS.marksPerPage) {
      const oldest = this.stored.findIndex((m) => m.state === 'taken')
      if (oldest === -1) {
        return null
      }
      this.stored.splice(oldest, 1)
    }
    this.nextNumber += 1
    return this.nextNumber - 1
  }

  add(stored: StoredMark): void {
    this.stored.push(stored)
    void stored.ready.then(this.changed)
    this.changed()
  }

  setNote(markId: string, note: string): void {
    const stored = this.stored.find((m) => m.mark.id === markId)
    if (stored) {
      stored.mark.note = note.slice(0, COBROWSE_LIMITS.note)
      this.changed()
    }
  }

  remove(markId: string): void {
    this.stored = this.stored.filter((m) => m.mark.id !== markId)
    if (this.stored.length === 0) {
      this.nextNumber = 1
    }
    this.changed()
  }

  /** The user's Send: drafts go to the agent waiting now, else to the next `marks`. */
  send(): void {
    const drafts = this.stored.filter((m) => m.state === 'draft')
    for (const m of drafts) {
      m.state = 'sent'
    }
    if (drafts.length > 0 && this.waiters.size > 0) {
      void this.deliver()
    }
    this.changed()
  }

  /** `browser.marks`: what the user sent and no agent took yet; waits up to `timeoutMs` for some. */
  async takeFor(options: MarkTakeOptions): Promise<{ marks: CobrowseMark[]; timedOut: boolean }> {
    if (options.peek) {
      await Promise.all(this.stored.map((m) => m.ready))
      return { marks: this.stored.map((m) => m.mark), timedOut: false }
    }
    if (this.stored.some((m) => m.state === 'sent') || !options.wait) {
      return { marks: await this.take(), timedOut: false }
    }
    return await new Promise((resolve) => {
      const finish = (marks: CobrowseMark[], timedOut: boolean): void => {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', abort)
        this.waiters.delete(waiter)
        this.changed()
        resolve({ marks, timedOut })
      }
      const waiter: Waiter = (marks) => finish(marks, false)
      const abort = (): void => finish([], true)
      const timer = setTimeout(abort, options.timeoutMs)
      options.signal?.addEventListener('abort', abort, { once: true })
      this.waiters.add(waiter)
      this.changed()
    })
  }

  /** The page is gone: waiting agents get nothing. */
  dispose(): void {
    for (const waiter of this.waiters) {
      waiter([])
    }
    this.stored = []
  }

  private async deliver(): Promise<void> {
    const marks = await this.take()
    for (const waiter of this.waiters) {
      waiter(marks)
    }
  }

  private async take(): Promise<CobrowseMark[]> {
    const sent = this.stored.filter((m) => m.state === 'sent')
    for (const m of sent) {
      m.state = 'taken'
    }
    await Promise.all(sent.map((m) => m.ready))
    this.changed()
    return sent.map((m) => m.mark)
  }
}
