import { describe, expect, it, vi } from 'vitest'
import type { CobrowseBox } from '../../../shared/browser-cobrowse-types'
import { PaneCobrowse } from './pod-browser-cobrowse'
import type { PodBrowserCobrowseServerMessage } from './pod-browser-cobrowse-protocol'

type Element = {
  id: number
  tag: string
  selector: string
  text: string
  box: CobrowseBox
  gone?: boolean
}

// What PaneCobrowse may ask of a page: reads only, nothing that draws into it or changes its DOM.
const READ_ONLY = new Set([
  'Page.getLayoutMetrics',
  'DOM.getNodeForLocation',
  'DOM.getBoxModel',
  'DOM.describeNode',
  'DOM.resolveNode',
  'DOM.scrollIntoViewIfNeeded',
  'Runtime.callFunctionOn',
  'Runtime.releaseObject',
  'Runtime.evaluate',
  'Accessibility.getPartialAXTree'
])

/** A page as CDP sees it: elements at document coordinates, a scroll, a 1000x600 viewport. */
class FakePage {
  scrollY = 0
  readonly calls: { method: string; params?: Record<string, unknown> }[] = []
  constructor(readonly elements: Element[]) {}

  find(id: number): Element | undefined {
    return this.elements.find((e) => e.id === id && !e.gone)
  }

  cdp = async (method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
    this.calls.push({ method, params })
    const id =
      typeof params.backendNodeId === 'number'
        ? params.backendNodeId
        : Number(String(params.objectId ?? '').slice(4))
    switch (method) {
      case 'Page.getLayoutMetrics':
        return {
          cssLayoutViewport: { pageX: 0, pageY: this.scrollY, clientWidth: 1000, clientHeight: 600 }
        }
      case 'DOM.getNodeForLocation': {
        const x = Number(params.x)
        const y = Number(params.y)
        const hit = this.elements
          .toReversed()
          .find(
            (e) =>
              !e.gone &&
              x >= e.box.x &&
              x < e.box.x + e.box.width &&
              y >= e.box.y &&
              y < e.box.y + e.box.height
          )
        if (!hit) {
          throw new Error('No node found at given location')
        }
        return { backendNodeId: hit.id, frameId: 'main' }
      }
      case 'DOM.getBoxModel': {
        const element = this.find(id)
        if (!element) {
          throw new Error('Could not compute box model.')
        }
        const { x, width, height } = element.box
        const y = element.box.y - this.scrollY
        return { model: { border: [x, y, x + width, y, x + width, y + height, x, y + height] } }
      }
      case 'DOM.describeNode':
        return { node: { backendNodeId: id, localName: this.find(id)?.tag, attributes: [] } }
      case 'DOM.resolveNode':
        return { object: { objectId: `obj-${id}` } }
      case 'Runtime.callFunctionOn': {
        const element = this.find(id)
        return String(params.functionDeclaration).includes('limits')
          ? {
              result: {
                value: element && {
                  tag: element.tag,
                  selector: element.selector,
                  text: element.text,
                  html: `<${element.tag}>`,
                  frameUrl: null
                }
              }
            }
          : { result: { objectId: `obj-${id}` } }
      }
      case 'Runtime.evaluate': {
        const selector = /document\.querySelector\((.*)\)$/.exec(String(params.expression))?.[1]
        const element = selector
          ? this.elements.find((e) => !e.gone && e.selector === JSON.parse(selector))
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
          (element.box.y < this.scrollY || element.box.y + element.box.height > this.scrollY + 600)
        ) {
          this.scrollY = Math.max(0, element.box.y - 100)
        }
        return {}
      }
      case 'Runtime.releaseObject':
        return {}
      default:
        throw new Error(`unexpected CDP call ${method}`)
    }
  }
}

function setup(elements: Element[], options: { watching?: boolean } = {}) {
  // Each test its own copy, so one that fails leaves the next a whole page.
  const page = new FakePage(elements.map((e) => ({ ...e, box: { ...e.box } })))
  const sent: PodBrowserCobrowseServerMessage[] = []
  const capture = vi.fn(async () => 'iVBORw0KGgo=')
  const release = vi.fn()
  let ids = 0
  const cobrowse = new PaneCobrowse({
    pageId: 'page-1',
    cdp: () => page.cdp,
    releaseCdp: release,
    capture,
    send: (message) => sent.push(message),
    attached: () => true,
    paneShown: () => true,
    page: () => ({ url: 'http://localhost:5173/settings', title: 'Settings' }),
    zoom: () => 1,
    now: () => new Date('2026-10-18T12:00:00Z'),
    randomId: () => `pointer-${++ids}`
  })
  if (options.watching !== false) {
    cobrowse.setWatching(true)
  }
  const state = () => sent.findLast((m) => m.type === 'browserCobrowseState')
  return { page, sent, cobrowse, capture, release, state }
}

const SAVE: Element = {
  id: 7,
  tag: 'button',
  selector: 'button#save',
  text: 'Save',
  box: { x: 100, y: 900, width: 80, height: 30 }
}
const FORM: Element = {
  id: 3,
  tag: 'form',
  selector: 'form.settings',
  text: 'Settings',
  box: { x: 0, y: 0, width: 1000, height: 2000 }
}
const MARK_ID = '6c1f7f0e-9a3b-4c2d-8e1f-0a1b2c3d4e5f'

// Lets the paint-scheduled geometry read (one CDP round trip chain) finish.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('co-browse marks', () => {
  it('a mark on an element stays on it while the page scrolls, and its locator names that element', async () => {
    const { page, cobrowse, state } = setup([FORM, SAVE])
    page.scrollY = 800
    await cobrowse.addMark(MARK_ID, 120, 110, 0, 0)
    expect(state()?.marks[0]).toMatchObject({
      n: 1,
      state: 'draft',
      rect: { x: 100, y: 100, width: 80, height: 30 }
    })

    page.scrollY = 850
    cobrowse.onPaint()
    await settle()
    expect(state()?.marks[0].rect).toEqual({ x: 100, y: 50, width: 80, height: 30 })

    cobrowse.setNote(MARK_ID, 'Too close to the edge')
    cobrowse.send()
    const { marks } = await cobrowse.takeMarks({ wait: false, timeoutMs: 1000, peek: false })
    expect(marks).toHaveLength(1)
    expect(marks[0]).toMatchObject({
      note: 'Too close to the edge',
      kind: 'element',
      element: { selector: 'button#save', role: 'button', name: 'Save' },
      box: { x: 100, y: 100 },
      pageBox: { x: 100, y: 900 },
      viewport: { scrollY: 800 },
      screenshot: { mimeType: 'image/png' }
    })
    // The locator still resolves to the element the user marked, at its new place.
    const found = await page.cdp('Runtime.evaluate', {
      expression: `document.querySelector(${JSON.stringify(marks[0].element?.selector)})`
    })
    expect(found).toEqual({ result: { objectId: 'obj-7', subtype: 'node' } })
    expect(state()?.marks[0].state).toBe('taken')
  })

  it('an agent waiting for marks gets them the moment the user sends, and the pane shows it waits', async () => {
    const { cobrowse, state } = setup([FORM, SAVE])
    const waiting = cobrowse.takeMarks({ wait: true, timeoutMs: 60_000, peek: false })
    expect(state()?.agentWaiting).toBe(true)
    await cobrowse.addMark(MARK_ID, 120, 300, 0, 0)
    cobrowse.send()
    const result = await waiting
    expect(result.timedOut).toBe(false)
    expect(result.marks.map((m) => m.id)).toEqual([MARK_ID])
    expect(state()?.agentWaiting).toBe(false)
  })

  it('a waiter whose agent went away leaves the page, so the pane stops saying it waits', async () => {
    const { cobrowse, state } = setup([FORM])
    const abort = new AbortController()
    const waiting = cobrowse.takeMarks({
      wait: true,
      timeoutMs: 60_000,
      peek: false,
      signal: abort.signal
    })
    expect(state()?.agentWaiting).toBe(true)
    abort.abort()
    expect((await waiting).timedOut).toBe(true)
    expect(state()?.agentWaiting).toBe(false)
  })

  it('a draft is not delivered until the user sends it', async () => {
    const { cobrowse } = setup([FORM, SAVE])
    await cobrowse.addMark(MARK_ID, 120, 300, 0, 0)
    expect((await cobrowse.takeMarks({ wait: false, timeoutMs: 1000, peek: false })).marks).toEqual(
      []
    )
    expect(
      (await cobrowse.takeMarks({ wait: false, timeoutMs: 1000, peek: true })).marks
    ).toHaveLength(1)
  })

  it('a region mark keeps its place relative to the element under it', async () => {
    const { page, cobrowse, state } = setup([FORM, SAVE])
    await cobrowse.addMark(MARK_ID, 200, 300, 100, 50)
    expect(state()?.marks[0]).toMatchObject({
      kind: 'region',
      rect: { x: 200, y: 300, width: 100, height: 50 }
    })
    page.scrollY = 100
    cobrowse.onPaint()
    await settle()
    expect(state()?.marks[0].rect).toEqual({ x: 200, y: 200, width: 100, height: 50 })
  })
})

describe('co-browse pointers', () => {
  it('a pointer follows its element and clears when the element goes', async () => {
    const { page, cobrowse, state } = setup([FORM, SAVE])
    const { pointerId, box } = await cobrowse.point({
      selector: 'button#save',
      label: 'Click Save',
      keep: false
    })
    // Below the fold: the page scrolled it into view first.
    expect(page.scrollY).toBe(800)
    expect(box).toEqual({ x: 100, y: 100, width: 80, height: 30 })
    expect(state()?.pointers).toEqual([
      { id: pointerId, label: 'Click Save', rect: { x: 100, y: 100, width: 80, height: 30 } }
    ])

    page.scrollY = 700
    cobrowse.onPaint()
    await settle()
    expect(state()?.pointers[0].rect).toEqual({ x: 100, y: 200, width: 80, height: 30 })

    page.elements.find((e) => e.id === SAVE.id)!.gone = true
    cobrowse.onPaint()
    await settle()
    expect(state()?.pointers).toEqual([])
  })

  it('the next point replaces the previous one unless kept, and a mark made meanwhile answers it', async () => {
    const { cobrowse, state } = setup([FORM, SAVE])
    await cobrowse.point({ selector: 'form.settings', label: 'Step 1', keep: false })
    await cobrowse.point({ selector: 'button#save', label: 'Step 2', keep: false })
    expect(state()?.pointers.map((p) => p.label)).toEqual(['Step 2'])
    await cobrowse.point({ selector: 'form.settings', label: 'Also this', keep: true })
    expect(state()?.pointers.map((p) => p.label)).toEqual(['Step 2', 'Also this'])
    await cobrowse.addMark(MARK_ID, 120, 110, 0, 0)
    cobrowse.send()
    const [mark] = (await cobrowse.takeMarks({ wait: false, timeoutMs: 1000, peek: false })).marks
    expect(mark.replyTo.map((r) => r.label)).toEqual(['Step 2', 'Also this'])
  })

  it('a selector that matches nothing says so', async () => {
    const { cobrowse } = setup([FORM])
    await expect(cobrowse.point({ selector: '#missing', label: '', keep: false })).rejects.toThrow(
      'Nothing on the page matches #missing'
    )
  })

  it('a page no pane watches gets no pushes, and the agent learns nobody sees its pointer', async () => {
    const { cobrowse, sent } = setup([FORM, SAVE], { watching: false })
    await cobrowse.point({ selector: 'button#save', label: 'Here', keep: false })
    expect(sent).toEqual([])
    expect(cobrowse.shownToUser).toBe(false)
  })
})

describe('co-browse costs and page safety', () => {
  it('asks the page only to read, never to draw into it or change it', async () => {
    const { page, cobrowse } = setup([FORM, SAVE])
    cobrowse.setMarkMode(true)
    await cobrowse.hoverAt(120, 110)
    await cobrowse.addMark(MARK_ID, 120, 300, 0, 0)
    await cobrowse.point({ selector: 'button#save', label: 'x', keep: false })
    cobrowse.onPaint()
    await settle()
    const methods = page.calls.map((c) => c.method)
    expect(methods.filter((m) => !READ_ONLY.has(m))).toEqual([])
    expect(methods.some((m) => m.startsWith('Overlay.'))).toBe(false)
    const evaluated = page.calls
      .filter((c) => c.method === 'Runtime.evaluate')
      .map((c) => String(c.params?.expression))
    expect(evaluated.every((e) => e.startsWith('document.querySelector('))).toBe(true)
  })

  it('a page with nothing tracked does no CDP work when it paints', async () => {
    const { page, cobrowse } = setup([FORM, SAVE])
    page.calls.length = 0
    for (let i = 0; i < 10; i++) {
      cobrowse.onPaint()
    }
    await settle()
    expect(page.calls).toEqual([])
  })

  it('a burst of paints reads geometry once per round trip, not once per frame', async () => {
    const { page, cobrowse } = setup([FORM, SAVE])
    await cobrowse.point({ selector: 'button#save', label: 'x', keep: false })
    await settle()
    page.calls.length = 0
    for (let i = 0; i < 30; i++) {
      cobrowse.onPaint()
    }
    await settle()
    await settle()
    expect(page.calls.filter((c) => c.method === 'DOM.getBoxModel').length).toBeLessThanOrEqual(2)
  })

  it('the hover outline answers each move with the element under it', async () => {
    const { page, cobrowse, sent } = setup([FORM, SAVE])
    page.scrollY = 800
    cobrowse.setMarkMode(true)
    await cobrowse.hoverAt(120, 110)
    expect(sent.at(-1)).toEqual({
      type: 'browserHover',
      pageId: 'page-1',
      rect: { x: 100, y: 100, width: 80, height: 30 },
      label: 'button'
    })
    await cobrowse.hoverAt(5, 5)
    expect(sent.at(-1)).toMatchObject({ type: 'browserHover', label: 'form' })
    cobrowse.setMarkMode(false)
    await cobrowse.hoverAt(120, 110)
    expect(sent.at(-1)).toMatchObject({ label: '' })
  })

  it('lets go of the page debugger once nothing is marked, pointed at or hovered', async () => {
    const { cobrowse, release } = setup([FORM, SAVE])
    await cobrowse.point({ selector: 'button#save', label: 'x', keep: false })
    release.mockClear()
    cobrowse.clearPointers()
    expect(release).toHaveBeenCalled()
  })
})
