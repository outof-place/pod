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
  readViewport,
  screenshotClip,
  type CobrowseCdp,
  type CobrowseViewport
} from './pod-browser-cobrowse-cdp'
import {
  clipChain,
  clipsBox,
  clipsHolding,
  intersect,
  nonNegative,
  showsIn,
  type Clip
} from './pod-browser-cobrowse-clip'
import type { PodBrowserCobrowseServerMessage } from './pod-browser-cobrowse-protocol'
import { readElement } from './pod-browser-cobrowse-read-element'

export type Anchor = {
  node: number | null
  // The node's frame, from the hit test that found it: point --mark finds the node there again.
  frameId?: string
  // What clips the node (scroll containers, frames), found when it was anchored.
  clips: Clip[]
  // A region's place relative to its node's box; null for the node's own box.
  offset: CobrowseBox | null
  // With no node: its place in the document (CSS px), so it scrolls with the page.
  doc: CobrowseBox | null
  // What PodNative last drew; null while not on the page.
  rect: CobrowseBox | null
  // Where its clips let it show (view coordinates), null when nothing but the viewport does.
  clip: CobrowseBox | null
  // None of it shows: its clips or the viewport hide all of it.
  outOfSight: boolean
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
  // The number of one of the user's marks on the page: its own element, in its frame.
  mark?: number
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

export function relative(
  region: CobrowseBox | null,
  nodeBox: CobrowseBox | null
): CobrowseBox | null {
  return region && nodeBox ? { ...region, x: region.x - nodeBox.x, y: region.y - nodeBox.y } : null
}

export function inDocument(box: CobrowseBox, viewport: CobrowseViewport): CobrowseBox {
  return { ...box, x: box.x + viewport.scrollX, y: box.y + viewport.scrollY }
}

/** Whether an anchor moves with the page (on a node, or held in the document). */
export function isLive(anchor: Anchor): boolean {
  return anchor.node !== null || anchor.doc !== null
}

/** The anchor as PodNative draws it: its box (CSS px, null once gone), where its clips let it show. */
export function settle(
  anchor: Anchor,
  box: CobrowseBox | null,
  clip: CobrowseBox | null,
  viewport: CobrowseViewport | null,
  zoom: number
): void {
  anchor.rect = box ? scaleBox(box, zoom) : null
  anchor.clip = box && clip ? scaleBox(nonNegative(clip), zoom) : null
  const view = viewport && { x: 0, y: 0, width: viewport.width, height: viewport.height }
  const inClip = box !== null && (!clip || showsIn(box, clip))
  anchor.outOfSight =
    box !== null && !(inClip && (!view || showsIn(clip ? intersect(box, clip) : box, view)))
}

/** The part of a box its clips and the viewport show (CSS px), or null when none of it does. */
export function shownPart(
  box: CobrowseBox,
  clip: CobrowseBox | null,
  viewport: CobrowseViewport
): CobrowseBox | null {
  const view = { x: 0, y: 0, width: viewport.width, height: viewport.height }
  const inClip = clip ? intersect(box, clip) : box
  return (!clip || showsIn(box, clip)) && showsIn(inClip, view)
    ? nonNegative(intersect(inClip, view))
    : null
}

/** A node anchor's clips, kept to those around all of a region on it. */
export async function anchorClips(
  cdp: CobrowseCdp,
  node: number,
  frameId: string | undefined,
  region: CobrowseBox | null,
  boxes: Map<number, Promise<CobrowseBox | null>>
): Promise<Clip[]> {
  const clips = await clipChain(cdp, node, frameId)
  return region ? clipsHolding(cdp, clips, region, boxes) : clips
}

/** Each anchor's box as the page has it now, in view coordinates; null once its node is gone. */
export async function placeAnchors(
  cdp: CobrowseCdp,
  tracked: readonly { anchor: Anchor }[],
  zoom: number
): Promise<void> {
  const viewport = tracked.length > 0 ? readViewport(cdp).catch(() => null) : null
  const boxes = new Map<number, Promise<CobrowseBox | null>>()
  await Promise.all(
    tracked.map(async ({ anchor }) => {
      if (anchor.node !== null) {
        const [nodeBox, clip] = await Promise.all([
          boxOf(cdp, anchor.node),
          clipsBox(cdp, anchor.clips, boxes)
        ])
        settle(anchor, nodeBox ? placed(nodeBox, anchor.offset) : null, clip, await viewport, zoom)
      } else if (anchor.doc) {
        const view = await viewport
        if (view) {
          const box = {
            ...anchor.doc,
            x: anchor.doc.x - view.scrollX,
            y: anchor.doc.y - view.scrollY
          }
          settle(anchor, box, null, view, zoom)
        }
      }
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
  const hit = await hitTest(
    cdp,
    region ? region.x + region.width / 2 : at.x / zoom,
    region ? region.y + region.height / 2 : at.y / zoom,
    viewport
  )
  const node = hit?.node ?? null
  const boxes = new Map<number, Promise<CobrowseBox | null>>()
  const [nodeBox, clips] = hit
    ? await Promise.all([
        boxOf(cdp, hit.node),
        anchorClips(cdp, hit.node, hit.frameId, region, boxes)
      ])
    : [null, []]
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
  const anchor: Anchor = {
    node,
    frameId: hit?.frameId,
    clips,
    offset: relative(region, nodeBox),
    doc: nodeBox ? null : inDocument(box, viewport),
    rect: null,
    clip: null,
    outOfSight: false
  }
  settle(anchor, box, await clipsBox(cdp, clips, boxes), viewport, zoom)
  return { mark, anchor, viewport }
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

/** The hover outline for a view point: the part of the element under it that shows, its short name. */
export async function hoverAnswer(
  cdp: CobrowseCdp,
  point: { x: number; y: number },
  zoom: number,
  clipsOf: (node: number, frameId?: string) => Promise<Clip[]>
): Promise<{ rect: CobrowseBox | null; label: string; key: string }> {
  const viewport = await readViewport(cdp)
  const hit = await hitTest(cdp, point.x / zoom, point.y / zoom, viewport)
  if (!hit) {
    return { rect: null, label: '', key: '' }
  }
  const [box, label, clips] = await Promise.all([
    boxOf(cdp, hit.node),
    hoverLabel(cdp, hit.node),
    clipsOf(hit.node, hit.frameId)
  ])
  const shown = box ? shownPart(box, await clipsBox(cdp, clips), viewport) : null
  const rect = shown ? scaleBox(shown, zoom) : null
  return {
    rect,
    label: rect ? label : '',
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
      rect: state === 'taken' ? null : anchor.rect,
      ...(state === 'taken' ? {} : sight(anchor))
    })),
    pointers: pointers.map((p) => ({
      id: p.id,
      label: p.label,
      rect: p.anchor.rect,
      ...sight(p.anchor)
    }))
  }
}

// Optional on the wire: an older PodNative draws `rect` as it always did.
function sight(anchor: Anchor): { clip?: CobrowseBox; outOfSight?: true } {
  return {
    ...(anchor.rect && anchor.clip ? { clip: anchor.clip } : {}),
    ...(anchor.rect && anchor.outOfSight ? { outOfSight: true as const } : {})
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
