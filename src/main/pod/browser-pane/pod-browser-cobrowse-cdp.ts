// Fork-only (Pod): co-browse's reads of a page over CDP. Read only: nothing here adds to the page's DOM
// or CSS, listens in it, or draws into its frames (no Overlay domain), so the page and every agent
// screenshot stay as they are; PodNative draws marks and pointers natively.
import type { CobrowseBox } from '../../../shared/browser-cobrowse-types'

export type CobrowseCdp = (method: string, params?: Record<string, unknown>) => Promise<unknown>

// CDP replies are untyped JSON: read them field by field instead of trusting a shape.
export function rec(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? Object.fromEntries(Object.entries(value))
    : {}
}
export function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
export function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
const nums = (value: unknown): number[] | undefined =>
  Array.isArray(value) && value.every((v) => typeof v === 'number') ? value : undefined

export type CobrowseViewport = { width: number; height: number; scrollX: number; scrollY: number }

export async function readViewport(cdp: CobrowseCdp): Promise<CobrowseViewport> {
  const viewport = rec(rec(await cdp('Page.getLayoutMetrics')).cssLayoutViewport)
  return {
    width: num(viewport.clientWidth) ?? 0,
    height: num(viewport.clientHeight) ?? 0,
    scrollX: num(viewport.pageX) ?? 0,
    scrollY: num(viewport.pageY) ?? 0
  }
}

/** The node under a viewport point (CSS px); it pierces shadow roots and same-process iframes. */
export async function hitTest(
  cdp: CobrowseCdp,
  x: number,
  y: number,
  viewport: CobrowseViewport
): Promise<number | null> {
  if (x < 0 || y < 0 || x >= viewport.width || y >= viewport.height) {
    return null
  }
  try {
    // Why the scroll: getNodeForLocation takes document coordinates (DocumentToFrame in Blink).
    const hit = rec(
      await cdp('DOM.getNodeForLocation', {
        x: Math.round(x + viewport.scrollX),
        y: Math.round(y + viewport.scrollY),
        includeUserAgentShadowDOM: false,
        // As a click would: an element with pointer-events: none is not what the user points at.
        ignorePointerEventsNone: false
      })
    )
    return num(hit.backendNodeId) ?? null
  } catch {
    return null
  }
}

/** The border box's bounds in viewport CSS px, or null once the node is gone or not rendered. */
export async function boxOf(cdp: CobrowseCdp, backendNodeId: number): Promise<CobrowseBox | null> {
  try {
    return quadBounds(nums(rec(rec(await cdp('DOM.getBoxModel', { backendNodeId })).model).border))
  } catch {
    return null
  }
}

export function quadBounds(quad: readonly number[] | undefined): CobrowseBox | null {
  if (!quad || quad.length < 8) {
    return null
  }
  const xs = [quad[0], quad[2], quad[4], quad[6]]
  const ys = [quad[1], quad[3], quad[5], quad[7]]
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }
}

/** A short name for the hover outline: the tag, its id or first class. */
export async function hoverLabel(cdp: CobrowseCdp, backendNodeId: number): Promise<string> {
  try {
    const node = rec(rec(await cdp('DOM.describeNode', { backendNodeId })).node)
    const tag = str(node.localName) || str(node.nodeName)?.toLowerCase() || ''
    const raw = node.attributes
    const attributes = Array.isArray(raw) ? raw.filter((v) => typeof v === 'string') : []
    const value = (name: string): string | undefined => {
      const index = attributes.indexOf(name)
      return index !== -1 && index % 2 === 0 ? attributes[index + 1] : undefined
    }
    const id = value('id')
    if (id) {
      return `${tag}#${id}`.slice(0, 80)
    }
    const firstClass = value('class')?.trim().split(/\s+/)[0]
    return (firstClass ? `${tag}.${firstClass}` : tag).slice(0, 80)
  } catch {
    return ''
  }
}

/** The one element a CSS selector names in the main document, or null. Throws on a bad selector. */
export async function querySelectorNode(
  cdp: CobrowseCdp,
  selector: string
): Promise<number | null> {
  const reply = rec(
    await cdp('Runtime.evaluate', {
      expression: `document.querySelector(${JSON.stringify(selector)})`,
      silent: true
    })
  )
  if (reply.exceptionDetails) {
    throw new Error(`Not a CSS selector this page takes: ${selector}`)
  }
  const objectId = str(rec(reply.result).objectId)
  if (!objectId) {
    return null
  }
  try {
    return num(rec(rec(await cdp('DOM.describeNode', { objectId })).node).backendNodeId) ?? null
  } finally {
    void cdp('Runtime.releaseObject', { objectId }).catch(() => {})
  }
}

const MATCH_BOX = `function (box) {
  var e = this && this.nodeType === 1 ? this : this && this.parentElement;
  function near(a, b) { return Math.abs(a - b) <= 2; }
  while (e) {
    var r = e.getBoundingClientRect();
    if (near(r.left, box.x) && near(r.top, box.y) && near(r.width, box.width) && near(r.height, box.height)) return e;
    e = e.parentElement || (e.getRootNode && e.getRootNode().host) || null;
  }
  return this;
}`

/**
 * The element a box another tool reported belongs to (agent-browser's `get box` for a ref): the
 * node under its centre, or the ancestor whose box it is.
 */
export async function nodeForBox(
  cdp: CobrowseCdp,
  box: CobrowseBox,
  viewport: CobrowseViewport
): Promise<number | null> {
  const hit = await hitTest(cdp, box.x + box.width / 2, box.y + box.height / 2, viewport)
  if (hit === null) {
    return null
  }
  const resolved = await cdp('DOM.resolveNode', { backendNodeId: hit }).catch(() => null)
  const objectId = str(rec(rec(resolved).object).objectId)
  if (!objectId) {
    return hit
  }
  let matchId: string | undefined
  try {
    const matched = await cdp('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: MATCH_BOX,
      arguments: [{ value: box }],
      silent: true
    })
    matchId = str(rec(rec(matched).result).objectId)
    if (!matchId) {
      return hit
    }
    return (
      num(rec(rec(await cdp('DOM.describeNode', { objectId: matchId })).node).backendNodeId) ?? hit
    )
  } catch {
    return hit
  } finally {
    void cdp('Runtime.releaseObject', { objectId }).catch(() => {})
    if (matchId && matchId !== objectId) {
      void cdp('Runtime.releaseObject', { objectId: matchId }).catch(() => {})
    }
  }
}

export async function scrollIntoView(cdp: CobrowseCdp, backendNodeId: number): Promise<void> {
  await cdp('DOM.scrollIntoViewIfNeeded', { backendNodeId }).catch(() => {})
}

/**
 * The PNG clip for a mark: its box with a little context, inside the viewport. Page.captureScreenshot
 * takes the clip in DIP (document CSS px times the page's zoom; checked on Electron 45 at 150%).
 */
export function screenshotClip(
  box: CobrowseBox,
  viewport: CobrowseViewport,
  zoom: number
): { x: number; y: number; width: number; height: number; scale: number } | null {
  const pad = 8
  const left = Math.max(0, box.x - pad)
  const top = Math.max(0, box.y - pad)
  const right = Math.min(viewport.width, box.x + box.width + pad)
  const bottom = Math.min(viewport.height, box.y + box.height + pad)
  if (right - left < 1 || bottom - top < 1) {
    return null
  }
  const width = (right - left) * zoom
  const height = (bottom - top) * zoom
  // Why a cap: a mark on a whole section must not become a multi-megabyte image in the agent's context.
  const scale = Math.min(1, 1200 / Math.max(width, height))
  return {
    x: (left + viewport.scrollX) * zoom,
    y: (top + viewport.scrollY) * zoom,
    width,
    height,
    scale
  }
}

/**
 * A box outside the viewport (agent-browser's `get box` of an element below the fold) scrolled to
 * its centre, so the node under it can be found; the box as it then sits.
 */
export async function revealBox(
  cdp: CobrowseCdp,
  box: CobrowseBox,
  viewport: CobrowseViewport
): Promise<{ box: CobrowseBox; viewport: CobrowseViewport }> {
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  if (cx >= 0 && cy >= 0 && cx < viewport.width && cy < viewport.height) {
    return { box, viewport }
  }
  const left = Math.max(0, viewport.scrollX + cx - viewport.width / 2)
  const top = Math.max(0, viewport.scrollY + cy - viewport.height / 2)
  await cdp('Runtime.evaluate', {
    expression: `window.scrollTo({ left: ${Math.round(left)}, top: ${Math.round(top)}, behavior: 'instant' })`,
    silent: true
  }).catch(() => {})
  const after = await readViewport(cdp)
  return {
    box: {
      ...box,
      x: box.x - (after.scrollX - viewport.scrollX),
      y: box.y - (after.scrollY - viewport.scrollY)
    },
    viewport: after
  }
}
