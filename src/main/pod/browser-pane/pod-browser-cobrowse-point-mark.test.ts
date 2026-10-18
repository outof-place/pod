import { describe, expect, it } from 'vitest'
import {
  FORM,
  MARK_ID,
  SAVE,
  setup,
  type Element,
  type Frame
} from './pod-browser-cobrowse.test-support'

// A same-origin iframe (its content box 661,81 298x198) and a button inside it whose locator is
// unique only in the frame's document: the main document has no button#frame-buy.
const IFRAME: Element = {
  id: 40,
  tag: 'iframe',
  selector: 'iframe#frame',
  text: '',
  box: { x: 660, y: 80, width: 300, height: 200 },
  border: 1
}
const BUY: Element = {
  id: 42,
  tag: 'button',
  selector: 'button#frame-buy',
  text: 'Buy in frame',
  box: { x: 700, y: 140, width: 160, height: 36 },
  frame: 'F1',
  clippedBy: [IFRAME.id]
}
const FRAME_URL = 'http://localhost:5173/cobrowse-frame.html'
const FRAMES: Record<string, Frame> = { F1: { owner: IFRAME.id, doc: 41, url: FRAME_URL } }

async function markAndTake(cobrowse: ReturnType<typeof setup>['cobrowse'], x: number, y: number) {
  await cobrowse.addMark(MARK_ID, x, y, 0, 0)
  cobrowse.send()
  return (await cobrowse.takeMarks({ wait: false, timeoutMs: 1000, peek: false })).marks
}

describe('point --mark', () => {
  it('points back at a mark in an iframe: its own element, ringed inside its frame', async () => {
    const { cobrowse, state } = setup([FORM, IFRAME, BUY], { frames: FRAMES })
    const [mark] = await markAndTake(cobrowse, 720, 150)
    expect(mark.element).toMatchObject({ selector: 'button#frame-buy', frameUrl: FRAME_URL })
    // The locator alone searches the main document, which has no such button.
    await expect(
      cobrowse.point({ selector: 'button#frame-buy', label: '', keep: false })
    ).rejects.toThrow('Nothing on the page matches button#frame-buy')

    const { box } = await cobrowse.point({ mark: 1, label: 'This label?', keep: false })
    expect(box).toEqual({ x: 700, y: 140, width: 160, height: 36 })
    expect(state()?.pointers).toEqual([
      {
        id: 'pointer-1',
        label: 'This label?',
        rect: { x: 700, y: 140, width: 160, height: 36 },
        clip: { x: 661, y: 81, width: 298, height: 198 }
      }
    ])
  })

  it('a mark whose element the page rendered again is found by its locator in its frame', async () => {
    const { page, cobrowse } = setup([FORM, IFRAME, BUY], { frames: FRAMES })
    await markAndTake(cobrowse, 720, 150)
    // The button and its frame were made again (a dev server's hot reload): new nodes, a new frame
    // at the same URL; the old frame id names nothing now.
    page.find(BUY.id)!.gone = true
    page.elements.push({ ...BUY, id: 52, frame: 'F9', box: { ...BUY.box, y: 150 } })
    page.frames = { F9: { owner: IFRAME.id, doc: 51, url: FRAME_URL } }
    const { box } = await cobrowse.point({ mark: 1, label: '', keep: false })
    expect(box).toEqual({ x: 700, y: 150, width: 160, height: 36 })
  })

  it('outside mark mode scrolls the mark element into view, as a point at a locator does', async () => {
    const { page, cobrowse } = setup([FORM, SAVE])
    page.scrollY = 800
    await markAndTake(cobrowse, 120, 110)
    page.scrollY = 0
    const { box } = await cobrowse.point({ mark: 1, label: 'Here', keep: false })
    expect(page.scrollY).toBe(800)
    expect(box).toEqual({ x: 100, y: 100, width: 80, height: 30 })
  })

  it('a region mark is pointed at where the user drew it', async () => {
    const { cobrowse } = setup([FORM, SAVE])
    await cobrowse.addMark(MARK_ID, 200, 300, 100, 50)
    const { box } = await cobrowse.point({ mark: 1, label: '', keep: false })
    expect(box).toEqual({ x: 200, y: 300, width: 100, height: 50 })
  })

  it('a mark no longer on the page says so, and one whose element went says that', async () => {
    const { page, cobrowse } = setup([FORM, IFRAME, BUY], { frames: FRAMES })
    await expect(cobrowse.point({ mark: 5, label: '', keep: false })).rejects.toThrow(
      'No mark 5 on this page'
    )
    await markAndTake(cobrowse, 720, 150)
    page.find(BUY.id)!.gone = true
    await expect(cobrowse.point({ mark: 1, label: '', keep: false })).rejects.toThrow(
      'The element of mark 1 is no longer on the page'
    )
  })
})
