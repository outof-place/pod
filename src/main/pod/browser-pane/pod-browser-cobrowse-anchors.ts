// Fork-only (Pod): what co-browse attaches to a page. A mark or pointer holds the DOM node it is on
// (backendNodeId) and, for a region, its place relative to that node's box, so it moves with the
// node; one on no node holds its place in the document. The box PodNative last drew is in view
// coordinates (CSS px times the page's zoom).
import {
  cobrowseElementLabel,
  COBROWSE_LIMITS,
  type CobrowseBox,
  type CobrowseMark,
  type CobrowseMarkState,
  type CobrowseScreenshot
} from '../../../shared/browser-cobrowse-types'
import { sanitizeGrabUrl } from '../../browser/browser-grab-payload'
import {
  boxOf,
  hitTest,
  hoverLabel,
  nodeForBox,
  querySelectorNode,
  readViewport,
  revealBox,
  screenshotClip,
  scrollIntoView,
  type CobrowseCdp,
  type CobrowseViewport
} from './pod-browser-cobrowse-cdp'
import type { PodBrowserCobrowseServerMessage } from './pod-browser-cobrowse-protocol'
import { readElement } from './pod-browser-cobrowse-read-element'

export type Anchor = {
  node: number | null
  // A region's place relative to its node's box; null for the node's own box.
  offset: CobrowseBox | null
  // With no node: its place in the document (CSS px), so it scrolls with the page.
  doc: CobrowseBox | null
  // What PodNative last drew; null while not on the page.
  rect: CobrowseBox | null
}

export type StoredMark = {
  mark: CobrowseMark
  state: CobrowseMarkState
  anchor: Anchor
  ready: Promise<void>
}
export type Pointer = { id: string; label: string; anchor: Anchor }

export type PointRequest = {
  selector?: string
  box?: CobrowseBox
  region?: CobrowseBox
  label: string
  keep: boolean
}

type MarkDeps = {
  pageId: string
  page: () => { url: string; title: string }
  now?: () => Date
}

export function placed(box: CobrowseBox, offset: CobrowseBox | null): CobrowseBox {
  return offset
    ? { x: box.x + offset.x, y: box.y + offset.y, width: offset.width, height: offset.height }
    : box
}

/** CSS px of the viewport to view coordinates (what PodNative draws in). */
export function scaleBox(box: CobrowseBox, zoom: number): CobrowseBox {
  const round = (value: number): number => Math.round(value * zoom * 100) / 100
  return { x: round(box.x), y: round(box.y), width: round(box.width), height: round(box.height) }
}

function relative(region: CobrowseBox | null, nodeBox: CobrowseBox | null): CobrowseBox | null {
  return region && nodeBox ? { ...region, x: region.x - nodeBox.x, y: region.y - nodeBox.y } : null
}

function inDocument(box: CobrowseBox, viewport: CobrowseViewport): CobrowseBox {
  return { ...box, x: box.x + viewport.scrollX, y: box.y + viewport.scrollY }
}

/** Whether an anchor moves with the page (on a node, or held in the document). */
export function isLive(anchor: Anchor): boolean {
  return anchor.node !== null || anchor.doc !== null
}

/** Each anchor's box as the page has it now, in view coordinates; null once its node is gone. */
export async function placeAnchors(
  cdp: CobrowseCdp,
  tracked: readonly { anchor: Anchor }[],
  zoom: number
): Promise<void> {
  let viewport: Promise<CobrowseViewport> | null = null
  await Promise.all(
    tracked.map(async ({ anchor }) => {
      let box: CobrowseBox | null = null
      if (anchor.node !== null) {
        const nodeBox = await boxOf(cdp, anchor.node)
        box = nodeBox ? placed(nodeBox, anchor.offset) : null
      } else if (anchor.doc) {
        const { scrollX, scrollY } = await (viewport ??= readViewport(cdp))
        box = { ...anchor.doc, x: anchor.doc.x - scrollX, y: anchor.doc.y - scrollY }
      } else {
        return
      }
      anchor.rect = box ? scaleBox(box, zoom) : null
    })
  )
}

export type NewMark = { mark: Omit<CobrowseMark, 'n'>; anchor: Anchor; viewport: CobrowseViewport }

/** A draft mark for a click or region (view coordinates), or null where nothing is on the page. */
export async function newMark(
  cdp: CobrowseCdp,
  at: { markId: string; x: number; y: number; width: number; height: number },
  zoom: number,
  deps: MarkDeps,
  pointers: readonly Pointer[]
): Promise<NewMark | null> {
  const viewport = await readViewport(cdp)
  const region =
    at.width > 2 && at.height > 2
      ? { x: at.x / zoom, y: at.y / zoom, width: at.width / zoom, height: at.height / zoom }
      : null
  const node = await hitTest(
    cdp,
    region ? region.x + region.width / 2 : at.x / zoom,
    region ? region.y + region.height / 2 : at.y / zoom,
    viewport
  )
  const nodeBox = node === null ? null : await boxOf(cdp, node)
  const box = region ?? nodeBox
  if (!box) {
    return null
  }
  const { url, title } = deps.page()
  const mark: Omit<CobrowseMark, 'n'> = {
    id: at.markId,
    browserPageId: deps.pageId,
    url: sanitizeGrabUrl(url),
    title,
    note: '',
    createdAt: (deps.now?.() ?? new Date()).toISOString(),
    kind: region ? 'region' : 'element',
    element: null,
    box,
    pageBox: inDocument(box, viewport),
    viewport,
    replyTo: pointers.map((p) => ({ pointerId: p.id, label: p.label })),
    screenshot: null
  }
  return {
    mark,
    anchor: {
      node,
      offset: relative(region, nodeBox),
      doc: nodeBox ? null : inDocument(box, viewport),
      rect: scaleBox(box, zoom)
    },
    viewport
  }
}

/** What an agent reads of a mark: its element and a PNG of it, read once the ring shows. */
export async function describeMark(
  cdp: CobrowseCdp,
  mark: CobrowseMark,
  node: number | null,
  viewport: CobrowseViewport,
  zoom: number,
  capture: (clip: NonNullable<ReturnType<typeof screenshotClip>>) => Promise<string | null>
): Promise<void> {
  if (node !== null) {
    mark.element = await readElement(cdp, node)
  }
  const clip = screenshotClip(mark.box, viewport, zoom)
  const data = clip ? await capture(clip).catch(() => null) : null
  if (clip && data && data.length * 0.75 <= COBROWSE_LIMITS.screenshotBytes) {
    mark.screenshot = pngShot(data, clip)
  }
}

/**
 * The node and box an agent's pointer is on; throws when its locator names nothing on the page.
 * Without `scroll` (the user is marking) the page stays put and the pointer may sit off screen.
 */
export async function resolvePointer(
  cdp: CobrowseCdp,
  request: PointRequest,
  zoom: number,
  scroll: boolean
): Promise<{ anchor: Anchor; box: CobrowseBox }> {
  let viewport = await readViewport(cdp)
  const region = request.region ?? null
  let node: number | null = null
  if (request.selector !== undefined) {
    node = await querySelectorNode(cdp, request.selector)
    if (node === null) {
      throw new Error(`Nothing on the page matches ${request.selector}`)
    }
  } else if (request.box) {
    const revealed = scroll ? await revealBox(cdp, request.box, viewport) : null
    viewport = revealed?.viewport ?? viewport
    node = await nodeForBox(cdp, revealed?.box ?? request.box, viewport)
  } else if (region) {
    node = await hitTest(cdp, region.x + region.width / 2, region.y + region.height / 2, viewport)
  }
  if (node !== null && !region && scroll) {
    await scrollIntoView(cdp, node)
  }
  const nodeBox = node === null ? null : await boxOf(cdp, node)
  // A box off screen while the page may not scroll: held by its place in the document.
  const box = region ?? nodeBox ?? (scroll ? null : (request.box ?? null))
  if (!box) {
    throw new Error('That element is not on the page now')
  }
  const after = node !== null && !region && scroll ? await readViewport(cdp) : viewport
  return {
    anchor: {
      node,
      offset: relative(region, nodeBox),
      doc: nodeBox ? null : inDocument(box, after),
      rect: scaleBox(box, zoom)
    },
    box
  }
}

/** The hover outline for a view point: the element under it, its box and short name. */
export async function hoverAnswer(
  cdp: CobrowseCdp,
  point: { x: number; y: number },
  zoom: number
): Promise<{ rect: CobrowseBox | null; label: string; key: string }> {
  const viewport = await readViewport(cdp)
  const node = await hitTest(cdp, point.x / zoom, point.y / zoom, viewport)
  const box = node === null ? null : await boxOf(cdp, node)
  const label = node === null || !box ? '' : await hoverLabel(cdp, node)
  const rect = box ? scaleBox(box, zoom) : null
  return {
    rect,
    label,
    key: rect ? `${label}|${rect.x}|${rect.y}|${rect.width}|${rect.height}` : ''
  }
}

export function stateMessage(
  pageId: string,
  agentWaiting: boolean,
  marks: readonly StoredMark[],
  pointers: readonly Pointer[]
): PodBrowserCobrowseServerMessage {
  return {
    type: 'browserCobrowseState',
    pageId,
    agentWaiting,
    marks: marks.map(({ mark, state, anchor }) => ({
      id: mark.id,
      n: mark.n,
      note: mark.note,
      state,
      kind: mark.kind,
      label: cobrowseElementLabel(mark.element),
      // A taken mark is no longer tracked: its ring goes, the tray keeps it.
      rect: state === 'taken' ? null : anchor.rect
    })),
    pointers: pointers.map((p) => ({ id: p.id, label: p.label, rect: p.anchor.rect }))
  }
}

function pngShot(
  data: string,
  clip: { width: number; height: number; scale: number }
): CobrowseScreenshot {
  return {
    mimeType: 'image/png',
    data,
    width: Math.round(clip.width * clip.scale),
    height: Math.round(clip.height * clip.scale)
  }
}
