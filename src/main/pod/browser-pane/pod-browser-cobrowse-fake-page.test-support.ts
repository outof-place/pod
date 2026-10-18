// A page as Chromium's CDP answers co-browse's reads of it, for PaneCobrowse's tests.
import type { CobrowseBox } from '../../../shared/browser-cobrowse-types'

export type Element = {
  id: number
  tag: string
  selector: string
  text: string
  /** Its border box in document CSS px (in its scroll container as that sits unscrolled). */
  box: CobrowseBox
  gone?: boolean
  /** Border width: its padding box (what it clips its content to) is the border box inset by this. */
  border?: number
  /** The scroll container it sits in: it moves up by that container's `scrolled`. */
  in?: number
  scrolled?: number
  /** What the page's clip walk finds around it, nearest first (ids). */
  clippedBy?: number[]
  /** Its document's frame ('main' by default). */
  frame?: string
  /** The clip walk stops at its frame: a cross-origin frame hides who holds it. */
  crossOrigin?: boolean
}

export type Frame = { owner: number; doc: number; url: string }

// What PaneCobrowse may ask of a page: reads only, nothing that draws into it or changes its DOM.
export const READ_ONLY = new Set(
  [
    'Page.getLayoutMetrics Page.getFrameTree DOM.getNodeForLocation DOM.getBoxModel DOM.describeNode',
    'DOM.resolveNode DOM.getFrameOwner DOM.scrollIntoViewIfNeeded Runtime.callFunctionOn',
    'Runtime.getProperties Runtime.releaseObject Runtime.releaseObjectGroup Runtime.evaluate',
    'Accessibility.getPartialAXTree'
  ]
    .join(' ')
    .split(' ')
)

const quad = ({ x, y, width, height }: CobrowseBox): number[] => {
  const [right, bottom] = [x + width, y + height]
  return [x, y, right, y, right, bottom, x, bottom]
}
const inset = (b: CobrowseBox, by: number): CobrowseBox => ({
  x: b.x + by,
  y: b.y + by,
  width: b.width - 2 * by,
  height: b.height - 2 * by
})
const within = (b: CobrowseBox, x: number, y: number): boolean =>
  x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height

/**
 * Checked on Electron 45 (DESIGN.md LOOKED UP): elements at document CSS px, a 1000x600 DIP view
 * whose CSS viewport is that over the zoom; getBoxModel in viewport CSS px and clipped by nothing,
 * getNodeForLocation in document CSS px whatever the zoom, and it hits only what shows.
 */
export class FakePage {
  scrollY = 0
  failLayout = false
  frames: Record<string, Frame> = {}
  readonly calls: { method: string; params?: Record<string, unknown> }[] = []
  constructor(
    readonly elements: Element[],
    readonly zoom = 1
  ) {}

  get viewHeight(): number {
    return 600 / this.zoom
  }

  find(id: number): Element | undefined {
    return this.elements.find((e) => e.id === id && !e.gone)
  }

  /** An element's border box in the document now, its scroll container's scroll applied. */
  docBox(e: Element): CobrowseBox {
    const scrolled = e.in === undefined ? 0 : (this.find(e.in)?.scrolled ?? 0)
    return { ...e.box, y: e.box.y - scrolled }
  }

  private shows(e: Element, x: number, y: number): boolean {
    return (e.clippedBy ?? []).every((id) => {
      const clip = this.find(id)
      return !clip || within(inset(this.docBox(clip), clip.border ?? 0), x, y)
    })
  }

  private node(e: Element | undefined, id: number): Record<string, unknown> {
    const frame = Object.entries(this.frames).find(([, f]) => f.owner === id)
    return {
      backendNodeId: id,
      localName: e?.tag,
      attributes: [],
      ...(frame ? { contentDocument: { backendNodeId: frame[1].doc } } : {})
    }
  }

  cdp = async (method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
    this.calls.push({ method, params })
    const objectId = String(params.objectId ?? '')
    const id =
      typeof params.backendNodeId === 'number' ? params.backendNodeId : Number(objectId.slice(4))
    switch (method) {
      case 'Page.getLayoutMetrics':
        if (this.failLayout) {
          throw new Error('Target closed')
        }
        return {
          cssLayoutViewport: {
            pageX: 0,
            pageY: this.scrollY,
            clientWidth: Math.floor(1000 / this.zoom),
            clientHeight: Math.floor(this.viewHeight)
          }
        }
      case 'Page.getFrameTree':
        return {
          frameTree: {
            frame: { id: 'main', url: 'http://localhost:5173/settings' },
            childFrames: Object.entries(this.frames).map(([frameId, f]) => ({
              frame: { id: frameId, url: f.url }
            }))
          }
        }
      case 'DOM.getNodeForLocation': {
        const x = Number(params.x)
        const y = Number(params.y)
        const hit = this.elements
          .toReversed()
          .find((e) => !e.gone && within(this.docBox(e), x, y) && this.shows(e, x, y))
        if (!hit) {
          throw new Error('No node found at given location')
        }
        return { backendNodeId: hit.id, frameId: hit.frame ?? 'main' }
      }
      case 'DOM.getBoxModel': {
        const element = this.find(id)
        if (!element) {
          throw new Error('Could not compute box model.')
        }
        const doc = this.docBox(element)
        const box = { ...doc, y: doc.y - this.scrollY }
        const inner = quad(inset(box, element.border ?? 0))
        return { model: { border: quad(box), padding: inner, content: inner } }
      }
      case 'DOM.describeNode':
        return { node: this.node(this.find(id), id) }
      case 'DOM.resolveNode': {
        const frame = Object.entries(this.frames).find(([, f]) => f.doc === id)
        return {
          object: { objectId: frame ? `doc-${frame[0]}` : `obj-${id}` }
        }
      }
      case 'DOM.getFrameOwner': {
        const frame = this.frames[String(params.frameId)]
        if (!frame) {
          throw new Error('Frame with the given id was not found.')
        }
        return { backendNodeId: frame.owner }
      }
      case 'Runtime.callFunctionOn':
        return this.call(String(params.functionDeclaration), objectId, id, params.arguments)
      case 'Runtime.getProperties': {
        const element = this.find(Number(objectId.slice(6)))
        const entries = (element?.clippedBy ?? []).map((clip, i) => ({
          name: String(i),
          value: { type: 'object', subtype: 'node', objectId: `obj-${clip}` }
        }))
        if (element?.crossOrigin) {
          entries.push({
            name: String(entries.length),
            value: { type: 'string', subtype: 'string', objectId: '' }
          })
        }
        return {
          result: [...entries, { name: 'length', value: { type: 'number' } }]
        }
      }
      case 'Runtime.evaluate': {
        const selector = /document\.querySelector\((.*)\)$/.exec(String(params.expression))?.[1]
        // The main document only: an iframe's elements are not in it.
        const element = selector
          ? this.elements.find(
              (e) =>
                !e.gone && (e.frame ?? 'main') === 'main' && e.selector === JSON.parse(selector)
            )
          : undefined
        return {
          result: element ? { objectId: `obj-${element.id}`, subtype: 'node' } : { subtype: 'null' }
        }
      }
      case 'Accessibility.getPartialAXTree': {
        const element = this.find(id)
        return {
          nodes: element
            ? [
                {
                  backendDOMNodeId: id,
                  role: { value: element.tag },
                  name: { value: element.text }
                }
              ]
            : []
        }
      }
      case 'DOM.scrollIntoViewIfNeeded': {
        const element = this.find(id)
        if (
          element &&
          (element.box.y < this.scrollY ||
            element.box.y + element.box.height > this.scrollY + this.viewHeight)
        ) {
          this.scrollY = Math.max(0, element.box.y - 100)
        }
        return {}
      }
      case 'Runtime.releaseObject':
      case 'Runtime.releaseObjectGroup':
        return {}
      default:
        throw new Error(`unexpected CDP call ${method}`)
    }
  }

  private call(fn: string, objectId: string, id: number, args: unknown): unknown {
    const element = this.find(id)
    if (fn.includes('limits')) {
      const frame = element?.frame && element.frame !== 'main' ? this.frames[element.frame] : null
      return {
        result: {
          value: element && {
            tag: element.tag,
            selector: element.selector,
            text: element.text,
            html: `<${element.tag}>`,
            frameUrl: frame?.url ?? null
          }
        }
      }
    }
    if (fn.includes('cross-origin frame')) {
      return element?.clippedBy?.length || element?.crossOrigin
        ? {
            result: {
              type: 'object',
              subtype: 'array',
              objectId: `chain-${id}`
            }
          }
        : { result: { type: 'object', subtype: 'null', value: null } }
    }
    if (objectId.startsWith('doc-')) {
      const frameId = objectId.slice(4)
      const first: unknown = Array.isArray(args) ? args[0] : undefined
      const selector =
        typeof first === 'object' && first !== null && 'value' in first ? first.value : undefined
      const found = this.elements.find(
        (e) => !e.gone && e.frame === frameId && e.selector === selector
      )
      return {
        result: found ? { objectId: `obj-${found.id}`, subtype: 'node' } : { subtype: 'null' }
      }
    }
    return { result: { objectId: `obj-${id}` } }
  }
}
