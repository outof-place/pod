// Fork-only (Pod): what hides part of a marked or pointed-at element. DOM.getBoxModel and
// DOM.getContentQuads report an element's whole layout box, clipped by nothing (Electron 45, see
// DESIGN.md LOOKED UP), so a row its list scrolled away would get a ring over whatever is drawn
// there. The scroll containers and frames that clip a node are found once, when it is anchored; each
// refresh reads only their boxes, so an element nothing clips costs nothing more.
import type { CobrowseBox } from '../../../shared/browser-cobrowse-types'
import { num, quadBounds, rec, str, type CobrowseCdp } from './pod-browser-cobrowse-cdp'

/** An element whose box clips another: a scroll container (padding box) or a frame (content box). */
export type Clip = { node: number; frame: boolean }

// Runs on the element (Runtime.callFunctionOn) and changes nothing: the clipping ancestors along its
// containing blocks, nearest first, through same-origin frames (frameElement); a trailing string
// says the walk stopped at a frame it may not look out of.
export const COBROWSE_CLIP_CHAIN = `function () {
  var e = this && this.nodeType === 1 ? this : this && this.parentElement;
  var win = e && e.ownerDocument && e.ownerDocument.defaultView;
  if (!win) return null;
  var out = [], pos = win.getComputedStyle(e).position;
  function holdsFixed(s) {
    return s.transform !== 'none' || s.perspective !== 'none' || s.filter !== 'none' ||
      (s.backdropFilter || 'none') !== 'none' || /paint|layout|strict|content/.test(s.contain || '') ||
      /transform|perspective|filter/.test(s.willChange || '') || (s.containerType || 'normal') !== 'normal';
  }
  function up(n) { return n.assignedSlot || n.parentElement || (n.parentNode && n.parentNode.host) || null; }
  for (var guard = 0; guard < 1000; guard++) {
    var a = up(e);
    if (!a) {
      var owner = null;
      try { owner = win.frameElement; } catch (x) {}
      if (!owner) { if (win !== win.top) out.push('cross-origin frame'); break; }
      out.push(owner);
      win = owner.ownerDocument.defaultView;
      pos = win.getComputedStyle(owner).position;
      e = owner;
      continue;
    }
    e = a;
    var d = a.ownerDocument;
    if (a === d.documentElement || a === d.body) continue;
    var s = win.getComputedStyle(a);
    if (pos === 'fixed' ? !holdsFixed(s) : pos === 'absolute' && s.position === 'static' && !holdsFixed(s)) continue;
    if (s.overflowX !== 'visible' || s.overflowY !== 'visible' || /paint|strict|content/.test(s.contain || '')) out.push(a);
    pos = s.position;
  }
  return out.length ? out : null;
}`

// Each walk its own object group: one walk's release must not take objects another still reads.
let walks = 0

/**
 * The elements that clip a node, nearest first. `frameId` (the node's frame, from a hit test) lets
 * the walk go on past a cross-origin frame through DOM.getFrameOwner.
 */
export async function clipChain(
  cdp: CobrowseCdp,
  backendNodeId: number,
  frameId?: string
): Promise<Clip[]> {
  walks = (walks + 1) % 1_000_000
  const group = `pod-cobrowse-clip-${walks}`
  try {
    const objectId = str(
      rec(rec(await cdp('DOM.resolveNode', { backendNodeId, objectGroup: group })).object).objectId
    )
    if (!objectId) {
      return []
    }
    const reply = rec(
      await cdp('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: COBROWSE_CLIP_CHAIN,
        objectGroup: group,
        silent: true
      })
    )
    const list = str(rec(reply.result).objectId)
    if (!list) {
      return []
    }
    const entries = rec(
      await cdp('Runtime.getProperties', { objectId: list, ownProperties: true })
    ).result
    const values = (Array.isArray(entries) ? entries : [])
      .map((entry) => rec(entry))
      .filter((entry) => /^\d+$/.test(str(entry.name) ?? ''))
      .map((entry) => rec(entry.value))
    const stoppedAtFrame = values.some((value) => value.type === 'string')
    const clips = await Promise.all(
      values.map(async (value): Promise<Clip | null> => {
        const id = str(value.objectId)
        if (!id || value.subtype !== 'node') {
          return null
        }
        const node = rec(rec(await cdp('DOM.describeNode', { objectId: id })).node)
        const nodeId = num(node.backendNodeId)
        const tag = (str(node.localName) ?? '').toLowerCase()
        return nodeId === undefined
          ? null
          : { node: nodeId, frame: tag === 'iframe' || tag === 'frame' }
      })
    )
    const chain = clips.filter((clip): clip is Clip => clip !== null)
    // A cross-origin frame hides who holds it from its page; CDP knows when the node's own frame stopped the walk.
    if (stoppedAtFrame && frameId && !chain.some((clip) => clip.frame)) {
      const owner = num(rec(await cdp('DOM.getFrameOwner', { frameId })).backendNodeId)
      if (owner !== undefined) {
        chain.push({ node: owner, frame: true }, ...(await clipChain(cdp, owner)))
      }
    }
    return chain
  } catch {
    return []
  } finally {
    void cdp('Runtime.releaseObjectGroup', { objectGroup: group }).catch(() => {})
  }
}

/** The part of the viewport a clip lets its content show in (viewport CSS px), or null once it went. */
export async function clipBox(cdp: CobrowseCdp, clip: Clip): Promise<CobrowseBox | null> {
  try {
    const model = rec(rec(await cdp('DOM.getBoxModel', { backendNodeId: clip.node })).model)
    const quad = model[clip.frame ? 'content' : 'padding']
    return quadBounds(
      Array.isArray(quad) && quad.every((v) => typeof v === 'number') ? quad : undefined
    )
  } catch {
    return null
  }
}

export function intersect(a: CobrowseBox, b: CobrowseBox): CobrowseBox {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  return {
    x,
    y,
    width: Math.min(a.x + a.width, b.x + b.width) - x,
    height: Math.min(a.y + a.height, b.y + b.height) - y
  }
}

/** Whether any of `box` shows inside `area`: some of it, or the point or line of a box with no size. */
export function showsIn(box: CobrowseBox, area: CobrowseBox): boolean {
  const part = intersect(box, area)
  return box.width > 0 && box.height > 0
    ? part.width > 0 && part.height > 0
    : part.width >= 0 && part.height >= 0
}

type ClipBoxes = Map<number, Promise<CobrowseBox | null>>

// One read per clip and refresh, however many marks and pointers it holds.
function readClips(cdp: CobrowseCdp, clips: readonly Clip[], boxes: ClipBoxes) {
  return Promise.all(
    clips.map((clip) => {
      let box = boxes.get(clip.node)
      if (!box) {
        box = clipBox(cdp, clip)
        boxes.set(clip.node, box)
      }
      return box
    })
  )
}

/** Where its clips let a node show (viewport CSS px); null when nothing clips it. */
export async function clipsBox(
  cdp: CobrowseCdp,
  clips: readonly Clip[],
  boxes: ClipBoxes = new Map()
): Promise<CobrowseBox | null> {
  let area: CobrowseBox | null = null
  for (const box of await readClips(cdp, clips, boxes)) {
    if (box) {
      area = area ? intersect(area, box) : box
    }
  }
  return area
}

/** The clips a region lies wholly inside: one it crosses is not around what the user drew. */
export async function clipsHolding(
  cdp: CobrowseCdp,
  clips: readonly Clip[],
  region: CobrowseBox,
  boxes: ClipBoxes = new Map()
): Promise<Clip[]> {
  const read = await readClips(cdp, clips, boxes)
  return clips.filter((_, i) => {
    const box = read[i]
    const part = box ? intersect(box, region) : null
    return part !== null && part.width >= region.width && part.height >= region.height
  })
}

/** A box with no negative size (clips that miss each other leave nothing). */
export function nonNegative(box: CobrowseBox): CobrowseBox {
  return { ...box, width: Math.max(0, box.width), height: Math.max(0, box.height) }
}
