// Fork-only (Pod): a pane page's marks on their way from the user (draft, sent) to the agent that
// takes them, and the agents waiting on `marks --wait` for some.
import { COBROWSE_LIMITS, type CobrowseMark } from '../../../shared/browser-cobrowse-types'
import type { StoredMark } from './pod-browser-cobrowse-anchors'

type Taken = { marks: CobrowseMark[]; timedOut: boolean; pageClosed?: true }
// A waiter answers true when it took the marks (its agent was still there).
type Waiter = (result: Taken) => boolean

export type MarkTakeOptions = {
  wait: boolean
  timeoutMs: number
  // Every mark, nothing taken: for a copy as Markdown.
  peek: boolean
  signal?: AbortSignal
}

/** A note cut to COBROWSE_LIMITS.note code points (PodNative cuts by Unicode scalars, the same count). */
export function cutNote(note: string): string {
  const points = Array.from(note)
  return points.length > COBROWSE_LIMITS.note
    ? points.slice(0, COBROWSE_LIMITS.note).join('')
    : note
}

export class CobrowseMarkQueue {
  private stored: StoredMark[] = []
  private readonly waiters = new Set<Waiter>()
  private nextNumber = 1
  private closed = false

  // `changed`: what PodNative draws of the marks, or whether an agent waits, changed.
  constructor(private readonly changed: () => void) {}

  get marks(): readonly StoredMark[] {
    return this.stored
  }

  get agentWaiting(): boolean {
    return this.waiters.size > 0
  }

  has(markId: string): boolean {
    return this.stored.some((m) => m.mark.id === markId)
  }

  /** Room for one more mark: under marksPerPage, or a taken one can give way (a draft never does). */
  get hasRoom(): boolean {
    return (
      this.stored.length < COBROWSE_LIMITS.marksPerPage ||
      this.stored.some((m) => m.state === 'taken')
    )
  }

  /**
   * A draft the user just made, numbered now (the oldest taken mark gives way when the page is
   * full); `describe` reads what an agent gets of it. Null when there is no room: nothing changed.
   */
  add(
    entry: { mark: Omit<CobrowseMark, 'n'>; anchor: StoredMark['anchor'] },
    describe: (mark: CobrowseMark) => Promise<void>
  ): CobrowseMark | null {
    if (this.closed || this.has(entry.mark.id) || !this.hasRoom) {
      return null
    }
    if (this.stored.length >= COBROWSE_LIMITS.marksPerPage) {
      this.stored.splice(
        this.stored.findIndex((m) => m.state === 'taken'),
        1
      )
    }
    const mark: CobrowseMark = { ...entry.mark, n: this.nextNumber }
    this.nextNumber += 1
    const ready = describe(mark)
    this.stored.push({ mark, state: 'draft', anchor: entry.anchor, ready })
    void ready.then(this.changed)
    this.changed()
    return mark
  }

  setNote(markId: string, note: string): void {
    const stored = this.stored.find((m) => m.mark.id === markId)
    if (stored) {
      stored.mark.note = cutNote(note)
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
  async takeFor(options: MarkTakeOptions): Promise<Taken> {
    if (options.peek) {
      await Promise.all(this.stored.map((m) => m.ready))
      return { marks: this.stored.map((m) => m.mark), timedOut: false }
    }
    if (this.closed) {
      return { marks: [], timedOut: false, pageClosed: true }
    }
    if (this.stored.some((m) => m.state === 'sent') || !options.wait) {
      return { marks: await this.take(), timedOut: false }
    }
    return await new Promise((resolve) => {
      let done = false
      const finish = (result: Taken): boolean => {
        if (done) {
          return false
        }
        done = true
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', abort)
        this.waiters.delete(finish)
        this.changed()
        resolve(result)
        return true
      }
      const abort = (): void => void finish({ marks: [], timedOut: true })
      const timer = setTimeout(abort, options.timeoutMs)
      if (options.signal?.aborted) {
        abort()
        return
      }
      options.signal?.addEventListener('abort', abort, { once: true })
      this.waiters.add(finish)
      this.changed()
    })
  }

  /** The page is gone: waiting agents learn it closed. */
  dispose(): void {
    this.closed = true
    for (const waiter of this.waiters) {
      waiter({ marks: [], timedOut: false, pageClosed: true })
    }
    this.stored = []
  }

  // Why taken only once a waiter took them: one whose agent left during the reads must not swallow
  // them, and the tray must not say the agent has them before it does.
  private async deliver(): Promise<void> {
    const sent = this.stored.filter((m) => m.state === 'sent')
    await Promise.all(sent.map((m) => m.ready))
    // Another take may have had some meanwhile, or the user removed them.
    const still = sent.filter((m) => m.state === 'sent' && this.stored.includes(m))
    if (still.length === 0) {
      return
    }
    const marks = still.map((m) => m.mark)
    let took = false
    for (const waiter of this.waiters) {
      took = waiter({ marks, timedOut: false }) || took
    }
    if (took) {
      for (const m of still) {
        m.state = 'taken'
      }
      this.changed()
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
