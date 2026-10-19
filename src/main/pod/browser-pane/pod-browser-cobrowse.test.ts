import { describe, expect, it, vi } from 'vitest'
import { FORM, MARK_ID, READ_ONLY, SAVE, settle, setup } from './pod-browser-cobrowse.test-support'

describe('co-browse marks', () => {
  it("a click's mark never shows as a region while its element is still being read", async () => {
    const { page, cobrowse, sent } = setup([FORM, SAVE])
    page.scrollY = 800
    const labels = () =>
      sent.flatMap((m) => (m.type === 'browserCobrowseState' ? m.marks.map((x) => x.label) : []))
    await cobrowse.addMark(MARK_ID, 120, 110, 0, 0)
    await settle()
    expect(labels()).not.toContain('region')
    expect(labels().at(-1)).toBe('button "Save"')
  })

  it("a mark's screenshot is the page as marked, its element read while the capture waits its turn", async () => {
    const { page, cobrowse, capture } = setup([FORM, SAVE])
    page.scrollY = 800
    const read = page.cdp
    let elementRead = false
    page.cdp = async (method, params) => {
      if (method === 'Accessibility.getPartialAXTree') {
        page.scrollY = 850
        elementRead = true
      }
      return read(method, params)
    }
    capture.mockImplementation(async () => {
      const marked = page.scrollY === 800
      // Another capture holds the page's turn until the element was read.
      await vi.waitFor(() => expect(elementRead).toBe(true))
      return marked ? 'bWFya2Vk' : 'c2Nyb2xsZWQ='
    })
    await cobrowse.addMark(MARK_ID, 120, 110, 0, 0)
    await settle()
    const [mark] = (await cobrowse.takeMarks({ wait: false, timeoutMs: 1, peek: true })).marks
    expect(mark.element?.name).toBe('Save')
    expect(mark.screenshot?.data).toBe('bWFya2Vk')
  })

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

  it('a locator the page cannot take as CSS says which forms point takes', async () => {
    const { cobrowse, page } = setup([FORM])
    const evaluate = page.cdp
    page.cdp = async (method, params) =>
      method === 'Runtime.evaluate'
        ? { exceptionDetails: { text: 'SyntaxError' } }
        : evaluate(method, params)
    await expect(cobrowse.point({ selector: 'text=Save', label: '', keep: false })).rejects.toThrow(
      /an @ref from snapshot, or xpath=/
    )
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
    await settle()
    release.mockClear()
    cobrowse.clearPointers()
    expect(release).toHaveBeenCalled()
  })
})

describe('co-browse limits and refusals', () => {
  const MARK = (i: number) => `6c1f7f0e-9a3b-4c2d-8e1f-${String(i).padStart(12, '0')}`

  it('refuses the 21st mark nobody took, without evicting a draft or using up a number', async () => {
    const { cobrowse, state, refused } = setup([FORM, SAVE])
    for (let i = 0; i < 20; i++) {
      await cobrowse.addMark(MARK(i), 120, 300, 0, 0)
    }
    await cobrowse.addMark(MARK(20), 120, 300, 0, 0)
    expect(state()?.marks).toHaveLength(20)
    expect(refused().at(-1)).toMatchObject({
      markId: MARK(20),
      reason: expect.stringContaining('20 marks')
    })
    cobrowse.removeMark(MARK(19))
    await cobrowse.addMark(MARK(21), 120, 300, 0, 0)
    // 20 went to the mark removed; the refused one used none.
    expect(state()?.marks.at(-1)).toMatchObject({ id: MARK(21), n: 21 })
  })

  it('a full page makes room by dropping the oldest mark an agent already took', async () => {
    const { cobrowse, state } = setup([FORM, SAVE])
    for (let i = 0; i < 20; i++) {
      await cobrowse.addMark(MARK(i), 120, 300, 0, 0)
    }
    cobrowse.send()
    await cobrowse.takeMarks({ wait: false, timeoutMs: 1000, peek: false })
    await cobrowse.addMark(MARK(20), 120, 300, 0, 0)
    expect(state()?.marks).toHaveLength(20)
    expect(state()?.marks[0].id).toBe(MARK(1))
    expect(state()?.marks.at(-1)).toMatchObject({ id: MARK(20), n: 21, state: 'draft' })
  })

  it('a click on nothing hit-testable is refused and burns no number', async () => {
    const { page, cobrowse, state, refused } = setup([SAVE])
    await cobrowse.addMark(MARK(1), 900, 500, 0, 0)
    expect(refused()).toEqual([
      {
        type: 'browserMarkRefused',
        pageId: 'page-1',
        markId: MARK(1),
        reason: 'Nothing on the page there to mark.'
      }
    ])
    expect(state()?.marks ?? []).toEqual([])
    page.scrollY = 800
    await cobrowse.addMark(MARK(2), 120, 110, 0, 0)
    expect(state()?.marks.map((m) => m.n)).toEqual([1])
  })

  it('a repeated markAdd makes one mark', async () => {
    const { cobrowse, state } = setup([FORM, SAVE])
    await Promise.all([
      cobrowse.addMark(MARK_ID, 120, 300, 0, 0),
      cobrowse.addMark(MARK_ID, 120, 300, 0, 0)
    ])
    await cobrowse.addMark(MARK_ID, 120, 300, 0, 0)
    expect(state()?.marks.map((m) => m.n)).toEqual([1])
  })

  it('keeps at most five pointers, the oldest giving way', async () => {
    const { cobrowse, state } = setup([FORM, SAVE])
    for (let i = 1; i <= 6; i++) {
      await cobrowse.point({ selector: 'form.settings', label: `Step ${i}`, keep: true })
    }
    expect(state()?.pointers.map((p) => p.label)).toEqual([
      'Step 2',
      'Step 3',
      'Step 4',
      'Step 5',
      'Step 6'
    ])
  })

  it('cuts a note at 2000 code points, emoji counted once', async () => {
    const { cobrowse } = setup([FORM, SAVE])
    await cobrowse.addMark(MARK_ID, 120, 300, 0, 0)
    cobrowse.setNote(MARK_ID, '😀'.repeat(2100))
    const [mark] = (await cobrowse.takeMarks({ wait: false, timeoutMs: 1, peek: true })).marks
    expect(Array.from(mark.note)).toHaveLength(2000)
    expect(mark.note.endsWith('😀')).toBe(true)
  })
})

describe('co-browse waiting agents', () => {
  it('a wait with nothing sent ends at its timeout', async () => {
    vi.useFakeTimers()
    try {
      const { cobrowse, state } = setup([FORM])
      const waiting = cobrowse.takeMarks({ wait: true, timeoutMs: 5000, peek: false })
      await vi.advanceTimersByTimeAsync(4999)
      expect(state()?.agentWaiting).toBe(true)
      await vi.advanceTimersByTimeAsync(1)
      expect(await waiting).toMatchObject({ marks: [], timedOut: true })
      expect(state()?.agentWaiting).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a waiter learns the tab closed, not that the wait timed out', async () => {
    const { cobrowse } = setup([FORM])
    const waiting = cobrowse.takeMarks({ wait: true, timeoutMs: 60_000, peek: false })
    cobrowse.dispose()
    expect(await waiting).toMatchObject({ marks: [], timedOut: false, pageClosed: true })
    expect(await cobrowse.takeMarks({ wait: true, timeoutMs: 60_000, peek: false })).toMatchObject({
      pageClosed: true
    })
  })

  it('marks sent while the only waiter leaves stay sent for the next agent', async () => {
    const { cobrowse, capture, state } = setup([FORM, SAVE])
    let finishShot: (data: string) => void = () => {}
    capture.mockImplementationOnce(() => new Promise<string>((resolve) => (finishShot = resolve)))
    const abort = new AbortController()
    const waiting = cobrowse.takeMarks({
      wait: true,
      timeoutMs: 60_000,
      peek: false,
      signal: abort.signal
    })
    await cobrowse.addMark(MARK_ID, 120, 300, 0, 0)
    cobrowse.send()
    // The screenshot is still being read when the agent goes away.
    await vi.waitFor(() => expect(capture).toHaveBeenCalled())
    expect(state()?.marks[0].state).toBe('sent')
    abort.abort()
    expect((await waiting).timedOut).toBe(true)
    finishShot('iVBORw0KGgo=')
    await settle()
    expect(state()?.marks[0].state).toBe('sent')
    const next = await cobrowse.takeMarks({ wait: true, timeoutMs: 60_000, peek: false })
    expect(next.marks.map((m) => m.id)).toEqual([MARK_ID])
  })
})

describe('co-browse debugger lease', () => {
  it('a waiting agent does not hold the page debugger, and it goes once the wait ends', async () => {
    const { cobrowse, lease } = setup([FORM, SAVE])
    await cobrowse.point({ selector: 'button#save', label: 'x', keep: false })
    const waiting = cobrowse.takeMarks({ wait: true, timeoutMs: 10, peek: false })
    cobrowse.clearPointers()
    await settle()
    expect(lease.held).toBe(false)
    await waiting
    expect(lease.held).toBe(false)
  })

  it('lets go once a pointer whose element went is pruned', async () => {
    const { page, cobrowse, lease } = setup([FORM, SAVE])
    await cobrowse.point({ selector: 'button#save', label: 'x', keep: false })
    expect(lease.held).toBe(true)
    page.elements.find((e) => e.id === SAVE.id)!.gone = true
    cobrowse.onPaint()
    await settle()
    await settle()
    expect(lease.held).toBe(false)
  })

  it('a page no pane draws holds nothing after a point, and a detached pane with marks lets go', async () => {
    const unwatched = setup([FORM, SAVE], { watching: false })
    await unwatched.cobrowse.point({ selector: 'button#save', label: 'x', keep: false })
    await settle()
    expect(unwatched.lease.held).toBe(false)

    const { cobrowse, lease } = setup([FORM, SAVE])
    await cobrowse.addMark(MARK_ID, 120, 300, 0, 0)
    await settle()
    expect(lease.held).toBe(true)
    cobrowse.setWatching(false)
    expect(lease.held).toBe(false)
  })

  it('marks an agent took stop being tracked: paints read nothing and the lease goes', async () => {
    const { page, cobrowse, lease, state } = setup([FORM, SAVE])
    await cobrowse.addMark(MARK_ID, 120, 300, 0, 0)
    cobrowse.send()
    await cobrowse.takeMarks({ wait: false, timeoutMs: 1, peek: false })
    await settle()
    expect(lease.held).toBe(false)
    expect(state()?.marks[0]).toMatchObject({ state: 'taken', rect: null })
    page.calls.length = 0
    cobrowse.onPaint()
    await settle()
    expect(page.calls).toEqual([])
  })
})

describe('co-browse hover answers', () => {
  it('echoes the hover seq and answers a failed hit test with no outline', async () => {
    const { page, cobrowse, sent } = setup([FORM, SAVE])
    cobrowse.setMarkMode(true)
    await cobrowse.hoverAt(120, 110, 7)
    expect(sent.at(-1)).toMatchObject({ type: 'browserHover', seq: 7, label: 'form' })
    page.failLayout = true
    await cobrowse.hoverAt(130, 110, 8)
    expect(sent.at(-1)).toEqual({
      type: 'browserHover',
      pageId: 'page-1',
      rect: null,
      label: '',
      seq: 8
    })
    cobrowse.setMarkMode(false)
    await cobrowse.hoverAt(120, 110, 9)
    expect(sent.at(-1)).toMatchObject({ rect: null, seq: 9 })
  })

  it('a refresh push carries no seq, so PodNative does not take it for its answer', async () => {
    const { page, cobrowse, sent } = setup([FORM, SAVE])
    page.scrollY = 800
    cobrowse.setMarkMode(true)
    await cobrowse.hoverAt(120, 110, 1)
    page.scrollY = 850
    cobrowse.onPaint()
    await settle()
    await settle()
    const hovers = sent.filter((m) => m.type === 'browserHover')
    expect(hovers.at(-1)).not.toHaveProperty('seq')
  })
})

describe('co-browse while the user marks', () => {
  it('a point never scrolls the page in mark mode; the pointer reports where it is', async () => {
    const { page, cobrowse, state } = setup([FORM, SAVE])
    cobrowse.setMarkMode(true)
    const { box } = await cobrowse.point({ selector: 'button#save', label: 'Below', keep: false })
    expect(page.scrollY).toBe(0)
    expect(box).toEqual({ x: 100, y: 900, width: 80, height: 30 })
    expect(state()?.pointers[0].rect).toEqual({ x: 100, y: 900, width: 80, height: 30 })
    cobrowse.setMarkMode(false)
    await cobrowse.point({ selector: 'button#save', label: 'Now', keep: false })
    expect(page.scrollY).toBe(800)
  })
})

describe('co-browse privacy', () => {
  it('the mark carries the page URL without its query or fragment', async () => {
    const { cobrowse } = setup([FORM, SAVE], {
      url: 'http://localhost:5173/settings?token=abc123&x=1#access_token=zzz'
    })
    await cobrowse.addMark(MARK_ID, 120, 300, 0, 0)
    const [mark] = (await cobrowse.takeMarks({ wait: false, timeoutMs: 1, peek: true })).marks
    expect(mark.url).toBe('http://localhost:5173/settings')
  })
})

// At 150% the view (PodNative's coordinates, browserInput's) is CSS px times 1.5; boxes below are
// worked out by hand from the elements' document boxes, not from the code's own scaling.
describe('co-browse at page zoom 150%', () => {
  it('a mark on an element follows it through a scroll', async () => {
    const { page, cobrowse, state, capture } = setup([FORM, SAVE], { zoom: 1.5 })
    page.scrollY = 800
    // View 180,165 is CSS 120,110 of the viewport, document 120,910: the Save button.
    await cobrowse.addMark(MARK_ID, 180, 165, 0, 0)
    expect(state()?.marks[0].rect).toEqual({ x: 150, y: 150, width: 120, height: 45 })
    page.scrollY = 850
    cobrowse.onPaint()
    await settle()
    expect(state()?.marks[0].rect).toEqual({ x: 150, y: 75, width: 120, height: 45 })
    // Its screenshot clip is in DIP: CSS 92,892 96x46 (the box and 8 px) times 1.5.
    expect(capture).toHaveBeenCalledWith({ x: 138, y: 1338, width: 144, height: 69, scale: 1 })
    const [mark] = (await cobrowse.takeMarks({ wait: false, timeoutMs: 1, peek: true })).marks
    expect(mark.box).toEqual({ x: 100, y: 100, width: 80, height: 30 })
  })

  it('the hover outline is the element under the view point', async () => {
    const { page, cobrowse, sent } = setup([FORM, SAVE], { zoom: 1.5 })
    page.scrollY = 800
    cobrowse.setMarkMode(true)
    await cobrowse.hoverAt(180, 165, 1)
    expect(sent.at(-1)).toMatchObject({ rect: { x: 150, y: 150, width: 120, height: 45 } })
    // View 180,120 is CSS 120,80: above the button, on the form, whose box (0,-800 1000x2000 CSS px)
    // shows only inside the 666x400 CSS viewport: 0,0 666x400, 0,0 999x600 in view coordinates.
    await cobrowse.hoverAt(180, 120, 2)
    expect(sent.at(-1)).toMatchObject({
      label: 'form',
      rect: { x: 0, y: 0, width: 999, height: 600 }
    })
  })

  it('a pointer scrolls its element into the smaller CSS viewport and rings it', async () => {
    const { page, cobrowse, state } = setup([FORM, SAVE], { zoom: 1.5 })
    const { box } = await cobrowse.point({ selector: 'button#save', label: 'Save', keep: false })
    // 900 + 30 is below the 400 CSS px viewport: scrolled to 900 - 100.
    expect(page.scrollY).toBe(800)
    expect(box).toEqual({ x: 100, y: 100, width: 80, height: 30 })
    expect(state()?.pointers[0].rect).toEqual({ x: 150, y: 150, width: 120, height: 45 })
  })
})
