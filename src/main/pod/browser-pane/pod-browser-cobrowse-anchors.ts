// Fork-only (Pod): what co-browse attaches to a page. A mark or pointer holds the DOM node it is on
// (backendNodeId) and, for a region, its place relative to that node's box, so it moves with the
// node; the box PodNative last drew is in view coordinates (CSS px times the page's zoom).
import {
  cobrowseElementLabel,
  type CobrowseBox,
  type CobrowseMark,
  type CobrowseMarkState,
  type CobrowseScreenshot
} from '../../../shared/browser-cobrowse-types'
import {
  boxOf,
  hitTest,
  hoverLabel,
  nodeForBox,
  querySelectorNode,
  readElement,
  readViewport,
  revealBox,
  screenshotClip,
  scrollIntoView,
  type CobrowseCdp,
  type CobrowseViewport
} from './pod-browser-cobrowse-cdp'
import type { PodBrowserCobrowseServerMessage } from './pod-browser-cobrowse-protocol'

export type Anchor = {
  node: number | null
  // A region's place relative to its node's box; null for the node's own box.
  offset: CobrowseBox | null
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
  zoom: () => number
  page: () => { url: string; title: string }
  now?: () => Date
}

export function placed(box: CobrowseBox, offset: CobrowseBox | null): CobrowseBox {
  return offset
    ? { x: box.x + offset.x, y: box.y + offset.y, width: offset.width, height: offset.height }
    : box
}

export function scaleBox(box: CobrowseBox, zoom: number): CobrowseBox {
  const round = (value: number): number => Math.round(value * zoom * 100) / 100
  return { x: round(box.x), y: round(box.y), width: round(box.width), height: round(box.height) }
}

function relative(region: CobrowseBox | null, nodeBox: CobrowseBox | null): CobrowseBox | null {
  return region && nodeBox ? { ...region, x: region.x - nodeBox.x, y: region.y - nodeBox.y } : null
}

/** A draft mark for a click or region (view coordinates), or null where nothing is on the page. */
export async function newMark(
  cdp: CobrowseCdp,
  at: { markId: string; n: number; x: number; y: number; width: number; height: number },
  deps: MarkDeps,
  pointers: readonly Pointer[]
): Promise<{ mark: CobrowseMark; anchor: Anchor; viewport: CobrowseViewport } | null> {
  const zoom = deps.zoom()
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
  const mark: CobrowseMark = {
    id: at.markId,
    n: at.n,
    browserPageId: deps.pageId,
    url,
    title,
    note: '',
    createdAt: (deps.now?.() ?? new Date()).toISOString(),
    kind: region ? 'region' : 'element',
    element: null,
    box,
    pageBox: { ...box, x: box.x + viewport.scrollX, y: box.y + viewport.scrollY },
    viewport,
    replyTo: pointers.map((p) => ({ pointerId: p.id, label: p.label })),
    screenshot: null
  }
  return {
    mark,
    anchor: { node, offset: relative(region, nodeBox), rect: scaleBox(box, zoom) },
    viewport
  }
}

/** What an agent reads of a mark: its element and a PNG of it, read once the ring shows. */
export async function describeMark(
  cdp: CobrowseCdp,
  mark: CobrowseMark,
  node: number | null,
  viewport: CobrowseViewport,
  capture: (clip: NonNullable<ReturnType<typeof screenshotClip>>) => Promise<string | null>
): Promise<void> {
  if (node !== null) {
    mark.element = await readElement(cdp, node)
  }
  const clip = screenshotClip(mark.box, viewport)
  const data = clip ? await capture(clip).catch(() => null) : null
  if (clip && data && data.length * 0.75 <= 2 * 1024 * 1024) {
    mark.screenshot = pngShot(data, clip)
  }
}

/** The node and box an agent's pointer is on; throws when its locator names nothing on the page. */
export async function resolvePointer(
  cdp: CobrowseCdp,
  request: PointRequest,
  zoom: number
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
    const revealed = await revealBox(cdp, request.box, viewport)
    viewport = revealed.viewport
    node = await nodeForBox(cdp, revealed.box, viewport)
  } else if (region) {
    node = await hitTest(cdp, region.x + region.width / 2, region.y + region.height / 2, viewport)
  }
  if (node !== null && !region) {
    await scrollIntoView(cdp, node)
  }
  const nodeBox = node === null ? null : await boxOf(cdp, node)
  const box = region ?? nodeBox
  if (!box) {
    throw new Error('That element is not on the page now')
  }
  return { anchor: { node, offset: relative(region, nodeBox), rect: scaleBox(box, zoom) }, box }
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
      rect: anchor.rect
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
