import { describe, expect, it } from 'vitest'
import {
  FORM,
  MARK_ID,
  SAVE,
  settle,
  setup,
  type Element,
  type Frame
} from './pod-browser-cobrowse.test-support'

// A list that scrolls inside itself, as the co-browse fixture has one: its border box 360,80
// 260x200 with a 1 px border, so it shows its rows only inside its padding box, 361,81 258x198.
// Row n's border box is 361, 81 + (n - 1) * 30, 258x30 while the list is not scrolled.
const LIST: Element = {
  id: 20,
  tag: 'ul',
  selector: 'ul#list',
  text: '',
  box: { x: 360, y: 80, width: 260, height: 200 },
  border: 1
}
const row = (n: number): Element => ({
  id: 100 + n,
  tag: 'li',
  selector: `li#item-${n}`,
  text: `Row ${n}`,
  box: { x: 361, y: 81 + (n - 1) * 30, width: 258, height: 30 },
  in: LIST.id,
  clippedBy: [LIST.id]
})
// What is drawn where the list's hidden rows would be.
const BELOW: Element = {
  id: 30,
  tag: 'div',
  selector: 'div#below',
  text: 'Below the list',
  box: { x: 360, y: 300, width: 260, height: 120 }
}
const PAGE = [FORM, LIST, ...Array.from({ length: 12 }, (_, i) => row(i + 1)), BELOW, SAVE]
const LIST_SHOWS = { x: 361, y: 81, width: 258, height: 198 }

describe('co-browse rings and scroll containers', () => {
  it('a pointer at a row its list scrolled away is out of sight there, then follows the row into view', async () => {
    const { page, cobrowse, state } = setup(PAGE)
    // The user is marking: the page may not move under their hand, so the list stays as it is.
    cobrowse.setMarkMode(true)
    const reply = await cobrowse.point({ selector: 'li#item-10', label: 'This row?', keep: false })
    // Row 10 is 351 to 381, over the box below the list; the list shows 81 to 279: none of it.
    expect(state()?.pointers).toEqual([
      {
        id: 'pointer-1',
        label: 'This row?',
        rect: { x: 361, y: 351, width: 258, height: 30 },
        clip: LIST_SHOWS,
        outOfSight: true
      }
    ])
    expect(reply.outOfSight).toBe(true)

    // Scrolled by 85: 266 to 296, its top 13 px in sight (PodNative rings only that part).
    page.find(LIST.id)!.scrolled = 85
    cobrowse.onPaint()
    await settle()
    expect(state()?.pointers[0]).toEqual({
      id: 'pointer-1',
      label: 'This row?',
      rect: { x: 361, y: 266, width: 258, height: 30 },
      clip: LIST_SHOWS
    })

    page.find(LIST.id)!.scrolled = 200
    cobrowse.onPaint()
    await settle()
    expect(state()?.pointers[0].rect).toEqual({ x: 361, y: 151, width: 258, height: 30 })
    expect(state()?.pointers[0]).not.toHaveProperty('outOfSight')
  })

  it('a mark whose row the user scrolls out of its list is out of sight, and gone only once removed', async () => {
    const { page, cobrowse, state } = setup(PAGE)
    cobrowse.setMarkMode(true)
    // Row 2: 111 to 141.
    await cobrowse.addMark(MARK_ID, 400, 120, 0, 0)
    expect(state()?.marks[0]).toMatchObject({
      rect: { x: 361, y: 111, width: 258, height: 30 },
      clip: LIST_SHOWS
    })
    expect(state()?.marks[0]).not.toHaveProperty('outOfSight')

    // Scrolled by 100: 11 to 41, above the list's 81.
    page.find(LIST.id)!.scrolled = 100
    cobrowse.onPaint()
    await settle()
    expect(state()?.marks[0]).toMatchObject({
      rect: { x: 361, y: 11, width: 258, height: 30 },
      outOfSight: true
    })

    page.find(102)!.gone = true
    cobrowse.onPaint()
    await settle()
    expect(state()?.marks[0].rect).toBeNull()
    expect(state()?.marks[0]).not.toHaveProperty('outOfSight')
  })

  it('the hover outline is the part of the element its list shows', async () => {
    const { page, cobrowse, sent } = setup(PAGE)
    // Scrolled by 15: row 1 is 66 to 96 and shows from the list's top, 81.
    page.find(LIST.id)!.scrolled = 15
    cobrowse.setMarkMode(true)
    await cobrowse.hoverAt(400, 90, 1)
    expect(sent.at(-1)).toEqual({
      type: 'browserHover',
      pageId: 'page-1',
      rect: { x: 361, y: 81, width: 258, height: 15 },
      label: 'li',
      seq: 1
    })
  })

  it('below the viewport is out of sight too, with no clip when only the viewport hides it', async () => {
    const { cobrowse, state } = setup(PAGE)
    cobrowse.setMarkMode(true)
    await cobrowse.point({ selector: 'button#save', label: 'Below', keep: false })
    expect(state()?.pointers[0]).toEqual({
      id: 'pointer-1',
      label: 'Below',
      rect: { x: 100, y: 900, width: 80, height: 30 },
      outOfSight: true
    })
  })

  it('a region is clipped by a list that holds all of it, not by one it crosses', async () => {
    const { cobrowse, state } = setup(PAGE)
    cobrowse.setMarkMode(true)
    await cobrowse.addMark(MARK_ID, 380, 100, 100, 50)
    await cobrowse.addMark('7c1f7f0e-9a3b-4c2d-8e1f-0a1b2c3d4e5f', 340, 100, 100, 50)
    expect(state()?.marks[0]).toMatchObject({ kind: 'region', clip: LIST_SHOWS })
    expect(state()?.marks[1]).toMatchObject({ kind: 'region' })
    expect(state()?.marks[1]).not.toHaveProperty('clip')
  })

  it('at 150% the clip is in view coordinates like the ring', async () => {
    const { cobrowse, state } = setup(PAGE, { zoom: 1.5 })
    cobrowse.setMarkMode(true)
    await cobrowse.point({ selector: 'li#item-10', label: '', keep: false })
    // 361,351 258x30 and 361,81 258x198 CSS px, times 1.5.
    expect(state()?.pointers[0]).toMatchObject({
      rect: { x: 541.5, y: 526.5, width: 387, height: 45 },
      clip: { x: 541.5, y: 121.5, width: 387, height: 297 },
      outOfSight: true
    })
  })

  it('an element in a cross-origin frame is clipped by the frame, found through CDP', async () => {
    // The frame's element shows its page inside its content box, 661,81 298x198; the page's own
    // walk stops at the frame (it may not see who holds it), the hit test names the frame.
    const iframe: Element = {
      id: 40,
      tag: 'iframe',
      selector: 'iframe#frame',
      text: '',
      box: { x: 660, y: 80, width: 300, height: 200 },
      border: 1
    }
    const buy: Element = {
      id: 42,
      tag: 'button',
      selector: 'button#frame-buy',
      text: 'Buy',
      box: { x: 700, y: 240, width: 160, height: 60 },
      frame: 'F2',
      crossOrigin: true
    }
    const frames: Record<string, Frame> = {
      F2: { owner: 40, doc: 41, url: 'http://127.0.0.1:5174/frame.html' }
    }
    const { cobrowse, state } = setup([FORM, iframe, buy], { frames })
    await cobrowse.addMark(MARK_ID, 720, 250, 0, 0)
    expect(state()?.marks[0]).toMatchObject({
      rect: { x: 700, y: 240, width: 160, height: 60 },
      clip: { x: 661, y: 81, width: 298, height: 198 }
    })
  })
})

describe('co-browse clip costs', () => {
  it('a frame reads one more box per clip, and an element nothing clips none', async () => {
    const plain = setup(PAGE)
    await plain.cobrowse.point({ selector: 'button#save', label: '', keep: false })
    await settle()
    plain.page.calls.length = 0
    plain.cobrowse.onPaint()
    await settle()
    const boxes = (calls: { method: string }[]) =>
      calls.filter((c) => c.method === 'DOM.getBoxModel').length
    expect(boxes(plain.page.calls)).toBe(1)
    // The clips are found once, when the pointer is made; a frame reads only boxes.
    expect(plain.page.calls.some((c) => c.method.startsWith('Runtime.'))).toBe(false)

    const listed = setup(PAGE)
    listed.cobrowse.setMarkMode(true)
    await listed.cobrowse.point({ selector: 'li#item-3', label: '', keep: false })
    await settle()
    listed.page.calls.length = 0
    listed.cobrowse.onPaint()
    await settle()
    expect(boxes(listed.page.calls)).toBe(2)
    expect(listed.page.calls.some((c) => c.method.startsWith('Runtime.'))).toBe(false)
  })
})
