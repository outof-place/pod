// Fork-only (Pod): co-browse on one pane page. The user's marks (PodNative's mark mode) and the agent's
// pointers live here, on the runtime that hosts the page, attached to DOM nodes by backendNodeId;
// PodNative draws them from the boxes this reports. While anything is tracked, each frame the page
// paints schedules one geometry read; a page that doesn't paint, or has nothing tracked, costs nothing.
import {
  COBROWSE_LIMITS,
  type CobrowseBox,
  type CobrowseMarksResult
} from '../../../shared/browser-cobrowse-types'
import { boxOf, type CobrowseCdp } from './pod-browser-cobrowse-cdp'
import {
  describeMark,
  hoverAnswer,
  newMark,
  placed,
  resolvePointer,
  scaleBox,
  stateMessage,
  type Pointer,
  type PointRequest
} from './pod-browser-cobrowse-anchors'
import { CobrowseMarkQueue, type MarkTakeOptions } from './pod-browser-cobrowse-mark-queue'
import type { PodBrowserCobrowseServerMessage } from './pod-browser-cobrowse-protocol'

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
  now?: () => Date
  randomId?: () => string
}

export class PaneCobrowse {
  private watching = false
  private markMode = false
  private hover: { x: number; y: number } | null = null
  private hoverShown = ''
  private readonly queue = new CobrowseMarkQueue(() => this.publish())
  private pointers: Pointer[] = []
  private refreshing = false
  private dirty = false
  private lastState = ''

  constructor(private readonly deps: PaneCobrowseDeps) {}

  /** PodNative's pane draws this page's marks and pointers (or stopped: detached, gone). */
  setWatching(watching: boolean): void {
    this.watching = watching && this.deps.attached()
    this.lastState = ''
    if (!this.watching) {
      this.markMode = false
      this.hover = null
      this.hoverShown = ''
    } else {
      this.publish()
      this.schedule()
    }
    this.releaseWhenIdle()
  }

  setMarkMode(on: boolean): void {
    this.markMode = on && this.watching
    if (!this.markMode) {
      this.hoverEnd()
    }
    this.releaseWhenIdle()
  }

  /** The pointer moved over the page in mark mode: one answer per call, so PodNative paces itself. */
  async hoverAt(x: number, y: number): Promise<void> {
    if (!this.markMode) {
      return
    }
    this.hover = { x, y }
    await this.sendHover(true)
  }

  hoverEnd(): void {
    this.hover = null
    if (this.hoverShown !== '') {
      this.hoverShown = ''
      this.deps.send({ type: 'browserHover', pageId: this.deps.pageId, rect: null, label: '' })
    }
  }

  /** A click (width and height 0) or a dragged region in mark mode, in view coordinates. */
  async addMark(
    markId: string,
    x: number,
    y: number,
    width: number,
    height: number
  ): Promise<void> {
    const cdp = this.deps.cdp()
    const n = cdp && this.watching && !this.queue.has(markId) ? this.queue.claimNumber() : null
    if (!cdp || n === null) {
      return
    }
    const made = await newMark(cdp, { markId, n, x, y, width, height }, this.deps, this.pointers)
    if (made) {
      // The ring shows now; what an agent reads of it follows and is waited for before delivery.
      const { mark, anchor, viewport } = made
      const ready = describeMark(cdp, mark, anchor.node, viewport, this.deps.capture)
      this.queue.add({ mark, state: 'draft', anchor, ready })
    }
  }

  setNote(markId: string, note: string): void {
    this.queue.setNote(markId, note)
  }

  removeMark(markId: string): void {
    this.queue.remove(markId)
    this.releaseWhenIdle()
  }

  send(): void {
    this.queue.send()
  }

  async takeMarks(options: MarkTakeOptions): Promise<CobrowseMarksResult> {
    return { browserPageId: this.deps.pageId, ...(await this.queue.takeFor(options)) }
  }

  /** An agent's pointer: a node it named, a box another tool found for its locator, or a region. */
  async point(request: PointRequest): Promise<{ pointerId: string; box: CobrowseBox }> {
    const cdp = this.deps.cdp()
    if (!cdp) {
      throw new Error('The page is gone')
    }
    const { anchor, box } = await resolvePointer(cdp, request, this.deps.zoom())
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
  }

  clearPointers(pointerId?: string): number {
    const before = this.pointers.length
    this.pointers = pointerId ? this.pointers.filter((p) => p.id !== pointerId) : []
    this.publish()
    this.releaseWhenIdle()
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
    this.deps.releaseCdp()
  }

  private tracking(): boolean {
    const tracked = this.hover !== null || this.queue.marks.length > 0 || this.pointers.length > 0
    return this.watching && this.deps.attached() && tracked
  }

  private schedule(): void {
    if (this.refreshing) {
      this.dirty = true
      return
    }
    this.refreshing = true
    void this.refresh().finally(() => {
      this.refreshing = false
      if (this.dirty) {
        this.dirty = false
        this.schedule()
      }
    })
  }

  private async refresh(): Promise<void> {
    const cdp = this.deps.cdp()
    if (!cdp || !this.tracking()) {
      return
    }
    const zoom = this.deps.zoom()
    const anchors = [...this.queue.marks, ...this.pointers].map((tracked) => tracked.anchor)
    await Promise.all(
      anchors.map(async (anchor) => {
        if (anchor.node === null) {
          return
        }
        const box = await boxOf(cdp, anchor.node)
        anchor.rect = box ? scaleBox(placed(box, anchor.offset), zoom) : null
      })
    )
    // A pointer goes with its element; a mark stays listed and only loses its ring.
    const gone = this.pointers.filter((p) => p.anchor.node !== null && p.anchor.rect === null)
    if (gone.length > 0) {
      this.pointers = this.pointers.filter((p) => !gone.includes(p))
    }
    if (this.hover) {
      await this.sendHover(false)
    }
    this.publish()
  }

  private async sendHover(always: boolean): Promise<void> {
    const cdp = this.deps.cdp()
    const point = this.hover
    if (!cdp || !point) {
      return
    }
    const { rect, label, key } = await hoverAnswer(cdp, point, this.deps.zoom())
    if (this.hover !== point && !always) {
      return
    }
    if (always || key !== this.hoverShown) {
      this.hoverShown = key
      this.deps.send({ type: 'browserHover', pageId: this.deps.pageId, rect, label })
    }
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

  private releaseWhenIdle(): void {
    if (!this.tracking() && !this.markMode && this.queue.idle && this.pointers.length === 0) {
      this.deps.releaseCdp()
    }
  }
}
