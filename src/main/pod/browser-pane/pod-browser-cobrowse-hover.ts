// Fork-only (Pod): the hover outline in mark mode. PodNative asks about one point at a time (its
// `seq`), and every ask gets exactly one answer, an empty one when the page can't say; while the
// page moves, a refresh pushes the outline again only when it changed, without a seq.
import type { CobrowseBox } from '../../../shared/browser-cobrowse-types'
import { hoverAnswer } from './pod-browser-cobrowse-anchors'
import type { CobrowseCdp } from './pod-browser-cobrowse-cdp'
import { clipChain, type Clip } from './pod-browser-cobrowse-clip'
import type { PodBrowserCobrowseServerMessage } from './pod-browser-cobrowse-protocol'

type HoverDeps = {
  pageId: string
  cdp: () => CobrowseCdp | null
  zoom: () => number
  send: (message: PodBrowserCobrowseServerMessage) => void
  log: (what: string, error: unknown) => void
}

// Enough for the elements a pointer crosses on its way; each one's clips are walked once.
const CHAINS_KEPT = 32

export class CobrowseHover {
  private point: { x: number; y: number } | null = null
  private shown = ''
  // What clips each element hovered lately: a refresh while the page scrolls reads only boxes.
  private readonly chains = new Map<number, Promise<Clip[]>>()

  constructor(private readonly deps: HoverDeps) {}

  get active(): boolean {
    return this.point !== null
  }

  /** An ask from PodNative; `marking` false answers it empty (mark mode just ended). */
  async ask(x: number, y: number, seq: number | undefined, marking: boolean): Promise<void> {
    if (!marking) {
      this.answer(null, '', seq)
      return
    }
    this.point = { x, y }
    await this.read(true, seq)
  }

  /** The page moved: the outline again, if it changed. */
  async refresh(): Promise<void> {
    if (this.point) {
      await this.read(false)
    }
  }

  end(): void {
    this.point = null
    this.chains.clear()
    if (this.shown !== '') {
      this.shown = ''
      this.answer(null, '')
    }
  }

  /** Forgets the outline without telling PodNative (the pane stopped watching). */
  reset(): void {
    this.point = null
    this.shown = ''
    this.chains.clear()
  }

  private clipsOf(cdp: CobrowseCdp, node: number, frameId?: string): Promise<Clip[]> {
    let chain = this.chains.get(node)
    if (!chain) {
      if (this.chains.size >= CHAINS_KEPT) {
        this.chains.delete(this.chains.keys().next().value ?? node)
      }
      chain = clipChain(cdp, node, frameId)
      this.chains.set(node, chain)
    }
    return chain
  }

  private async read(always: boolean, seq?: number): Promise<void> {
    const point = this.point
    const cdp = point ? this.deps.cdp() : null
    if (!cdp || !point) {
      if (always) {
        this.answer(null, '', seq)
      }
      return
    }
    let found: Awaited<ReturnType<typeof hoverAnswer>>
    try {
      found = await hoverAnswer(cdp, point, this.deps.zoom(), (node, frameId) =>
        this.clipsOf(cdp, node, frameId)
      )
    } catch (error) {
      this.deps.log('hover', error)
      found = { rect: null, label: '', key: '' }
    }
    if (this.point !== point && !always) {
      return
    }
    if (always || found.key !== this.shown) {
      this.shown = found.key
      this.answer(found.rect, found.label, seq)
    }
  }

  private answer(rect: CobrowseBox | null, label: string, seq?: number): void {
    this.deps.send({
      type: 'browserHover',
      pageId: this.deps.pageId,
      rect,
      label,
      ...(seq === undefined ? {} : { seq })
    })
  }
}
