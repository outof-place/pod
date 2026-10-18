// Fork-only (Pod): where an agent's pointer goes: the element its locator names, a box another tool
// found for one, a region, or one of the user's marks (point --mark). A mark's element is the node the
// user clicked, in its own frame or shadow root; when the page rendered it anew, its locator finds it
// again in that frame.
import type { CobrowseBox, CobrowseElement } from '../../../shared/browser-cobrowse-types'
import { sanitizeGrabUrl } from '../../browser/browser-grab-payload'
import {
  anchorClips,
  inDocument,
  placed,
  relative,
  settle,
  type Anchor,
  type PointRequest,
  type StoredMark
} from './pod-browser-cobrowse-anchors'
import {
  boxOf,
  hitTest,
  nodeForBox,
  num,
  querySelectorNode,
  readViewport,
  rec,
  revealBox,
  scrollIntoView,
  str,
  type CobrowseCdp,
  type Hit
} from './pod-browser-cobrowse-cdp'
import { clipsBox, type Clip } from './pod-browser-cobrowse-clip'

/** A mark the agent points back at: what the runtime holds of it. */
export type MarkTarget = { n: number; anchor: Anchor; element: CobrowseElement | null }

/** A point request with its mark number read into the mark. */
export type PointTarget = Omit<PointRequest, 'mark'> & { mark?: MarkTarget }

/** One of the user's marks by its number, as point --mark aims at it; throws when the page has none. */
export function markTarget(marks: readonly StoredMark[], n: number): MarkTarget {
  const stored = marks.find((m) => m.mark.n === n)
  if (!stored) {
    throw new Error(
      `No mark ${n} on this page now: the user removed it, or it was never made. Point with --element and its locator instead.`
    )
  }
  return { n, anchor: stored.anchor, element: stored.mark.element }
}

type Place = {
  hit: Hit | null
  offset: CobrowseBox | null
  doc: CobrowseBox | null
  clips?: Clip[]
}

/**
 * The node and box an agent's pointer is on; throws when its target names nothing on the page.
 * Without `scroll` (the user is marking) the page stays put and the pointer may sit off screen.
 */
export async function resolvePointer(
  cdp: CobrowseCdp,
  request: PointTarget,
  zoom: number,
  scroll: boolean
): Promise<{ anchor: Anchor; box: CobrowseBox }> {
  let viewport = await readViewport(cdp)
  const region = request.region ?? null
  let place: Place = { hit: null, offset: null, doc: null }
  if (request.mark) {
    place = await markPlace(cdp, request.mark)
  } else if (request.selector !== undefined) {
    const node = await querySelectorNode(cdp, request.selector)
    if (node === null) {
      throw new Error(`Nothing on the page matches ${request.selector}`)
    }
    place.hit = { node }
  } else if (request.box) {
    const revealed = scroll ? await revealBox(cdp, request.box, viewport) : null
    viewport = revealed?.viewport ?? viewport
    place.hit = await nodeForBox(cdp, revealed?.box ?? request.box, viewport)
  } else if (region) {
    place.hit = await hitTest(
      cdp,
      region.x + region.width / 2,
      region.y + region.height / 2,
      viewport
    )
  }
  const { hit, offset, doc } = place
  if (hit && !region && scroll) {
    await scrollIntoView(cdp, hit.node)
  }
  const after = hit && !region && scroll ? await readViewport(cdp) : viewport
  const nodeBox = hit ? await boxOf(cdp, hit.node) : null
  const docBox = doc && { ...doc, x: doc.x - after.scrollX, y: doc.y - after.scrollY }
  // A box off screen while the page may not scroll: held by its place in the document.
  const box =
    region ??
    (nodeBox ? placed(nodeBox, offset) : null) ??
    docBox ??
    (scroll ? null : (request.box ?? null))
  if (!box) {
    throw new Error('That element is not on the page now')
  }
  const boxes = new Map<number, Promise<CobrowseBox | null>>()
  const clips =
    place.clips ??
    (hit ? await anchorClips(cdp, hit.node, hit.frameId, region ?? (offset && box), boxes) : [])
  const anchor: Anchor = {
    node: hit?.node ?? null,
    frameId: hit?.frameId,
    clips,
    offset: offset ?? relative(region, nodeBox),
    doc: doc ?? (nodeBox ? null : inDocument(box, after)),
    rect: null,
    clip: null,
    outOfSight: false
  }
  settle(anchor, box, await clipsBox(cdp, clips, boxes), after, zoom)
  return { anchor, box }
}

// The mark's node while it lives, else the element its locator finds now in the mark's frame.
async function markPlace(cdp: CobrowseCdp, mark: MarkTarget): Promise<Place> {
  const { anchor } = mark
  if (anchor.node === null) {
    return { hit: null, offset: null, doc: anchor.doc }
  }
  if (await boxOf(cdp, anchor.node)) {
    const hit = { node: anchor.node, frameId: anchor.frameId }
    return { hit, offset: anchor.offset, doc: null, clips: anchor.clips }
  }
  const hit = await findAgain(cdp, mark)
  if (!hit) {
    throw new Error(`The element of mark ${mark.n} is no longer on the page`)
  }
  return { hit, offset: anchor.offset, doc: null }
}

async function findAgain(cdp: CobrowseCdp, { anchor, element }: MarkTarget): Promise<Hit | null> {
  if (!element || element.inShadowRoot) {
    return null
  }
  if (!element.frameUrl) {
    const node = await querySelectorNode(cdp, element.selector).catch(() => null)
    return node === null ? null : { node, frameId: anchor.frameId }
  }
  for (const frameId of await framesAt(cdp, anchor.frameId, element.frameUrl)) {
    const node = await queryInFrame(cdp, frameId, element.selector)
    if (node !== null) {
      return { node, frameId }
    }
  }
  return null
}

// The mark's frame by its id, then any frame now at its URL (the page made the frame again).
async function framesAt(cdp: CobrowseCdp, frameId: string | undefined, url: string) {
  const ids = frameId ? [frameId] : []
  const walk = (node: Record<string, unknown>): void => {
    const frame = rec(node.frame)
    const id = str(frame.id)
    const at = str(frame.url)
    if (id && at && sanitizeGrabUrl(at) === url && !ids.includes(id)) {
      ids.push(id)
    }
    for (const child of Array.isArray(node.childFrames) ? node.childFrames : []) {
      walk(rec(child))
    }
  }
  walk(rec(rec(await cdp('Page.getFrameTree').catch(() => null)).frameTree))
  return ids
}

const QUERY = 'function (selector) { return this.querySelector(selector) }'

// A selector in a frame's document: its element, its document (pierce), the query there.
async function queryInFrame(cdp: CobrowseCdp, frameId: string, selector: string) {
  const objects: string[] = []
  try {
    const owner = num(rec(await cdp('DOM.getFrameOwner', { frameId })).backendNodeId)
    const described =
      owner === undefined
        ? {}
        : rec(
            rec(await cdp('DOM.describeNode', { backendNodeId: owner, depth: 1, pierce: true }))
              .node
          )
    const doc = num(rec(rec(described).contentDocument).backendNodeId)
    const docObject =
      doc === undefined
        ? undefined
        : str(rec(rec(await cdp('DOM.resolveNode', { backendNodeId: doc })).object).objectId)
    if (!docObject) {
      return null
    }
    objects.push(docObject)
    const reply = rec(
      await cdp('Runtime.callFunctionOn', {
        objectId: docObject,
        functionDeclaration: QUERY,
        arguments: [{ value: selector }],
        silent: true
      })
    )
    const found = str(rec(reply.result).objectId)
    if (!found) {
      return null
    }
    objects.push(found)
    return (
      num(rec(rec(await cdp('DOM.describeNode', { objectId: found })).node).backendNodeId) ?? null
    )
  } catch {
    return null
  } finally {
    for (const objectId of objects) {
      void cdp('Runtime.releaseObject', { objectId }).catch(() => {})
    }
  }
}
