// Fork-only (Pod): co-browse on one pane page. The user's marks (PodNative's mark mode) and the agent's
// pointers live here, on the runtime that hosts the page, attached to DOM nodes by backendNodeId;
// PodNative draws them from the boxes this reports. While anything is tracked, each frame the page
// paints schedules one geometry read; a page that doesn't paint, or has nothing tracked, costs nothing.
import {
  COBROWSE_LIMITS,
  type CobrowseBox,
  type CobrowseMarksResult
} from '../../../shared/browser-cobrowse-types'
import type { CobrowseCdp } from './pod-browser-cobrowse-cdp'
import {
  describeMark,
  isLive,
  newMark,
  placeAnchors,
  resolvePointer,
  stateMessage,
  type Pointer,
  type PointRequest
} from './pod-browser-cobrowse-anchors'
import { CobrowseHover } from './pod-browser-cobrowse-hover'
import { CobrowseMarkQueue, type MarkTakeOptions } from './pod-browser-cobrowse-mark-queue'
import {
  COBROWSE_REFUSALS,
  type PodBrowserCobrowseServerMessage
} from './pod-browser-cobrowse-protocol'

export type PaneCobrowseDeps = {
  pageId: string
  // A CDP sender over the page's debugger lease, taken on first use; null when the page is gone.
  cdp: () => CobrowseCdp | null
  releaseCdp: () => void
  capture: (clip: Record<string, number>) => Promise<string | null>
  send: (message: PodBrowserCobrowseServerMessage) => void
  // A pane is attached to the page / shows it now.
  attached: () => boolean
  paneShown: () => boolean
  page: () => { url: string; title: string }
  // The page's zoom: view coordinates (PodNative's) are CSS px times this.
  zoom: () => number
  log?: (message: string) => void
  now?: () => Date
  randomId?: () => string
}

export class PaneCobrowse {
  private watching = false
  private markMode = false
  private readonly hover: CobrowseHover
  private readonly queue = new CobrowseMarkQueue(() => {
    this.publish()
    this.syncLease()
  })
  private pointers: Pointer[] = []
  private refreshing = false
  private dirty = false
  private lastState = ''
  // CDP reads in flight outside the per-frame refresh (a mark being made or described, a point).
  private busy = 0
  private leased = false

  constructor(private readonly deps: PaneCobrowseDeps) {
    this.hover = new CobrowseHover({
      pageId: deps.pageId,
      cdp: () => this.cdp(),
      zoom: deps.zoom,
      send: deps.send,
      log: (what, error) => this.log(what, error)
    })
  }

  /** PodNative's pane draws this page's marks and pointers (or stopped: detached, gone). */
  setWatching(watching: boolean): void {
    this.watching = watching && this.deps.attached()
    this.lastState = ''
    if (!this.watching) {
      this.markMode = false
      this.hover.reset()
    } else {
      this.publish()
      this.schedule()
    }
    this.syncLease()
  }

  setMarkMode(on: boolean): void {
    this.markMode = on && this.watching
    if (!this.markMode) {
      this.hoverEnd()
    }
    this.syncLease()
  }

  /** The pointer moved over the page in mark mode: always one answer, tagged with PodNative's `seq`. */
  async hoverAt(x: number, y: number, seq?: number): Promise<void> {
    await this.hover.ask(x, y, seq, this.markMode)
    this.syncLease()
  }

  hoverEnd(): void {
    this.hover.end()
    this.syncLease()
  }

  /**
   * A click (width and height 0) or a dragged region in mark mode, in view coordinates. One that
   * cannot become a mark is answered with browserMarkRefused, so PodNative drops its note field.
   */
  async addMark(
    markId: string,
    x: number,
    y: number,
    width: number,
    height: number
  ): Promise<void> {
    if (!this.watching || this.queue.has(markId)) {
      return
    }
    if (!this.queue.hasRoom) {
      this.refuse(markId, COBROWSE_REFUSALS.full)
      return
    }
    const cdp = this.cdp()
    if (!cdp) {
      this.refuse(markId, COBROWSE_REFUSALS.gone)
      return
    }
    this.busy += 1
    try {
      const zoom = this.deps.zoom()
      const made = await newMark(
        cdp,
        { markId, x, y, width, height },
        zoom,
        this.deps,
        this.pointers
      )
      if (!made) {
        this.refuse(markId, COBROWSE_REFUSALS.nothing)
        return
      }
      // The ring shows now; what an agent reads of it follows and is waited for before delivery.
      const added = this.queue.add({ mark: made.mark, anchor: made.anchor }, (mark) =>
        this.track(
          describeMark(cdp, mark, made.anchor.node, made.viewport, zoom, this.deps.capture).catch(
            (error: unknown) => this.log('describe a mark', error)
          )
        )
      )
      if (!added) {
        this.refuse(markId, COBROWSE_REFUSALS.full)
      }
    } catch (error) {
      this.log('add a mark', error)
      this.refuse(markId, COBROWSE_REFUSALS.failed)
    } finally {
      this.busy -= 1
      this.syncLease()
    }
  }

  setNote(markId: string, note: string): void {
    this.queue.setNote(markId, note)
  }

  removeMark(markId: string): void {
    this.queue.remove(markId)
  }

  send(): void {
    this.queue.send()
  }

  async takeMarks(options: MarkTakeOptions): Promise<CobrowseMarksResult> {
    return { browserPageId: this.deps.pageId, ...(await this.queue.takeFor(options)) }
  }

  /** An agent's pointer: a node it named, a box another tool found for its locator, or a region. */
  async point(request: PointRequest): Promise<{ pointerId: string; box: CobrowseBox }> {
    const cdp = this.cdp()
    if (!cdp) {
      throw new Error('The page is gone')
    }
    this.busy += 1
    try {
      // Why no scroll while the user marks: the page must not move under their pointer.
      const { anchor, box } = await resolvePointer(cdp, request, this.deps.zoom(), !this.markMode)
      if (!request.keep) {
        this.pointers = []
      }
      if (this.pointers.length >= COBROWSE_LIMITS.pointersPerPage) {
        this.pointers.shift()
      }
      const pointer: Pointer = {
        id: this.deps.randomId?.() ?? crypto.randomUUID(),
        label: request.label.slice(0, COBROWSE_LIMITS.label),
        anchor
      }
      this.pointers.push(pointer)
      this.publish()
      this.schedule()
      return { pointerId: pointer.id, box }
    } finally {
      this.busy -= 1
      this.syncLease()
    }
  }

  clearPointers(pointerId?: string): number {
    const before = this.pointers.length
    this.pointers = pointerId ? this.pointers.filter((p) => p.id !== pointerId) : []
    this.publish()
    this.syncLease()
    return before - this.pointers.length
  }

  get shownToUser(): boolean {
    return this.watching && this.deps.paneShown()
  }

  /** The page painted a frame: its marks, pointers and hover may have moved. */
  onPaint(): void {
    if (this.tracking()) {
      this.schedule()
    }
  }

  dispose(): void {
    this.watching = false
    this.queue.dispose()
    this.pointers = []
    this.busy = 0
    this.syncLease()
  }

  /** Whether the page's debugger is held now (tests and probes read it). */
  get holdsDebugger(): boolean {
    return this.leased
  }

  // Marks an agent took and pointers no pane draws need no geometry; neither do waiting agents.
  private tracking(): boolean {
    if (!this.watching || !this.deps.attached()) {
      return false
    }
    return (
      this.hover.active ||
      this.pointers.some((p) => isLive(p.anchor)) ||
      this.queue.marks.some((m) => m.state !== 'taken' && isLive(m.anchor))
    )
  }

  private cdp(): CobrowseCdp | null {
    const cdp = this.deps.cdp()
    this.leased ||= cdp !== null
    return cdp
  }

  // One rule after every change: hold the page's debugger only while something needs it.
  private syncLease(): void {
    const needed =
      this.busy > 0 ||
      this.refreshing ||
      (this.watching && this.deps.attached() && (this.markMode || this.tracking()))
    if (this.leased && !needed) {
      this.leased = false
      this.deps.releaseCdp()
    }
  }

  private track<T>(work: Promise<T>): Promise<T> {
    this.busy += 1
    return work.finally(() => {
      this.busy -= 1
      this.syncLease()
    })
  }

  private schedule(): void {
    if (this.refreshing) {
      this.dirty = true
      return
    }
    this.refreshing = true
    void this.refresh()
      .catch((error: unknown) => this.log('refresh', error))
      .finally(() => {
        this.refreshing = false
        if (this.dirty) {
          this.dirty = false
          this.schedule()
        } else {
          this.syncLease()
        }
      })
  }

  private async refresh(): Promise<void> {
    if (!this.tracking()) {
      return
    }
    const cdp = this.cdp()
    if (!cdp) {
      return
    }
    const marks = this.queue.marks.filter((m) => m.state !== 'taken')
    await placeAnchors(cdp, [...marks, ...this.pointers], this.deps.zoom())
    // A pointer goes with its element; a mark stays listed and only loses its ring.
    const gone = this.pointers.filter((p) => p.anchor.node !== null && p.anchor.rect === null)
    if (gone.length > 0) {
      this.pointers = this.pointers.filter((p) => !gone.includes(p))
    }
    await this.hover.refresh()
    this.publish()
  }

  private refuse(markId: string, reason: string): void {
    this.deps.send({ type: 'browserMarkRefused', pageId: this.deps.pageId, markId, reason })
  }

  private log(what: string, error: unknown): void {
    this.deps.log?.(
      `browser-cobrowse: ${what} failed: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  private publish(): void {
    if (!this.watching) {
      return
    }
    const { queue, pointers } = this
    const message = stateMessage(this.deps.pageId, queue.agentWaiting, queue.marks, pointers)
    const text = JSON.stringify(message)
    if (text !== this.lastState) {
      this.lastState = text
      this.deps.send(message)
    }
  }
}
