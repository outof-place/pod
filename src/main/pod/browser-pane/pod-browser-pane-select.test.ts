import { EventEmitter } from 'node:events'
import { Script } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PaneSelectMenus } from './pod-browser-pane-select'

class FakeWebContents extends EventEmitter {
  readonly scripts: { world: number; code: string }[] = []
  zoom = 1
  getZoomFactor = () => this.zoom
  executeJavaScriptInIsolatedWorld = vi.fn(async (world: number, sources: { code: string }[]) => {
    this.scripts.push(...sources.map(({ code }) => ({ world, code })))
  })
}

class FakeFrame extends EventEmitter {
  detached = false
  destroyed = false
  readonly scripts: string[] = []
  constructor(readonly parent: object | null = {}) {
    super()
  }
  isDestroyed = () => this.destroyed
  executeJavaScript = vi.fn(async (code: string) => {
    this.scripts.push(code)
  })
}

function setup() {
  const wc = new FakeWebContents()
  const onMenu = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake has every member PaneSelectMenus calls.
  const menus = new PaneSelectMenus(wc as unknown as Electron.WebContents, onMenu)
  wc.emit('dom-ready')
  const nonce = /pod-select " \+ "([0-9a-f]{32})"/.exec(wc.scripts[0]?.code ?? '')?.[1]
  return { wc, menus, onMenu, nonce }
}

describe('PaneSelectMenus', () => {
  it('puts its script in an isolated world on every load', () => {
    const { wc, nonce } = setup()
    expect(wc.scripts[0].world).toBe(1987)
    expect(nonce).toMatch(/^[0-9a-f]{32}$/)
    wc.emit('dom-ready')
    expect(wc.scripts).toHaveLength(2)
  })

  it("reads a menu from its own world's message and nothing from a page that imitates it", () => {
    const { wc, onMenu, nonce } = setup()
    const menu = {
      menuId: 3,
      x: 100,
      y: 120.5,
      width: 60,
      height: 24,
      items: [
        { label: 'one', enabled: true, selected: true, group: '' },
        { label: 'two', enabled: false, selected: false, group: 'Later' }
      ]
    }
    wc.emit('console-message', { message: `\u0000pod-select deadbeef ${JSON.stringify(menu)}` })
    wc.emit('console-message', { message: `\u0000pod-select ${nonce} not json` })
    wc.emit('console-message', { message: 'hello' })
    expect(onMenu).not.toHaveBeenCalled()
    wc.emit('console-message', { message: `\u0000pod-select ${nonce} ${JSON.stringify(menu)}` })
    // Under PodNative's own id.
    expect(onMenu).toHaveBeenCalledWith({ ...menu, menuId: 1 })
  })

  it("hands the pick to its world, under the script's own menu id", () => {
    const { wc, menus, nonce } = setup()
    const line = JSON.stringify({ menuId: 3, x: 0, y: 0, width: 0, height: 0, items: [] })
    wc.emit('console-message', { message: `\u0000pod-select ${nonce} ${line}` })
    menus.choose(1, 1)
    expect(wc.scripts.at(-1)).toEqual({ world: 1987, code: 'globalThis.__podSelectChoose?.(3, 1)' })
    // Answered once: a second pick, or one for a menu never shown, reaches nothing.
    menus.choose(1, 0)
    menus.choose(7, 0)
    expect(wc.scripts).toHaveLength(2)
  })
})

describe('PaneSelectMenus in an iframe', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  function frameSetup() {
    const { wc, menus, onMenu, nonce } = setup()
    const frame = new FakeFrame()
    wc.emit('frame-created', {}, { frame })
    frame.emit('dom-ready')
    const doc = /const doc = "([0-9a-f]{16})"/.exec(frame.scripts[0] ?? '')?.[1] ?? ''
    const line = (fields: object = {}): string =>
      `\u0000pod-select-frame ${JSON.stringify({
        doc,
        menuId: 4,
        clientX: 50,
        clientY: 20,
        x: 40,
        y: 10,
        width: 60,
        height: 24,
        items: [{ label: 'one', enabled: true, selected: true, group: '' }],
        ...fields
      })}`
    return { wc, menus, onMenu, nonce, frame, doc, line }
  }

  it("puts its script in the frame's document on every load, and none in the top frame", () => {
    const { wc, frame, doc } = frameSetup()
    expect(doc).toMatch(/^[0-9a-f]{16}$/)
    expect(frame.scripts[0]).toContain('if (!event.isTrusted) return')
    // Both scripts compile.
    expect(() => new Script(frame.scripts[0])).not.toThrow()
    expect(() => new Script(wc.scripts[0].code)).not.toThrow()
    frame.emit('dom-ready')
    expect(frame.scripts).toHaveLength(2)
    const top = new FakeFrame(null)
    wc.emit('frame-created', {}, { frame: top })
    top.emit('dom-ready')
    expect(top.scripts).toEqual([])
  })

  it("shows a frame's menu once per click of the user's, where the select sits on the page", () => {
    vi.useFakeTimers()
    const { wc, menus, onMenu, frame, line } = frameSetup()
    wc.emit('console-message', { message: line(), frame })
    expect(onMenu).not.toHaveBeenCalled()
    menus.noteClick(150, 220)
    wc.emit('console-message', { message: line(), frame })
    // The click is (50, 20) in the frame and (150, 220) on the page: the frame sits at (100, 200).
    expect(onMenu).toHaveBeenCalledWith({
      menuId: 1,
      x: 140,
      y: 210,
      width: 60,
      height: 24,
      items: [{ label: 'one', enabled: true, selected: true, group: '' }]
    })
    wc.emit('console-message', { message: line(), frame })
    expect(onMenu).toHaveBeenCalledTimes(1)
    menus.noteClick(150, 220)
    vi.advanceTimersByTime(1_001)
    wc.emit('console-message', { message: line(), frame })
    expect(onMenu).toHaveBeenCalledTimes(1)
  })

  it('opens the menu at the click when the box the frame reports misses it', () => {
    const { wc, menus, onMenu, frame, line } = frameSetup()
    menus.noteClick(150, 220)
    wc.emit('console-message', { message: line({ x: 400 }), frame })
    expect(onMenu).toHaveBeenCalledWith(
      expect.objectContaining({ x: 150, y: 220, width: 0, height: 0 })
    )
  })

  it('takes neither message from the other kind of frame, nor a malformed document id', () => {
    const { wc, menus, onMenu, nonce, frame, line } = frameSetup()
    menus.noteClick(150, 220)
    const top = new FakeFrame(null)
    wc.emit('console-message', { message: line(), frame: top })
    const own = JSON.stringify({ menuId: 1, x: 0, y: 0, width: 0, height: 0, items: [] })
    wc.emit('console-message', { message: `\u0000pod-select ${nonce} ${own}`, frame })
    wc.emit('console-message', { message: line({ doc: 'x"); alert(1); ("' }), frame })
    expect(onMenu).not.toHaveBeenCalled()
    // None of those used up the click.
    wc.emit('console-message', { message: line(), frame })
    expect(onMenu).toHaveBeenCalledTimes(1)
  })

  it("places the menus in the page view's px at a page zoom", () => {
    const { wc, menus, onMenu, nonce, frame, line } = frameSetup()
    wc.zoom = 1.2
    const own = JSON.stringify({ menuId: 1, x: 10, y: 20, width: 50, height: 10, items: [] })
    wc.emit('console-message', { message: `\u0000pod-select ${nonce} ${own}` })
    expect(onMenu).toHaveBeenLastCalledWith(expect.objectContaining({ x: 12, y: 24, width: 60, height: 12 }))
    // The click at view (180, 264) is CSS (150, 220): the frame's select lands where it did at 100%.
    menus.noteClick(180, 264)
    wc.emit('console-message', { message: line(), frame })
    expect(onMenu).toHaveBeenLastCalledWith(expect.objectContaining({ x: 168, y: 252, width: 72 }))
  })

  it("hands the pick to that frame's document only, and nothing once it is gone", () => {
    const { wc, menus, frame, doc, line } = frameSetup()
    menus.noteClick(150, 220)
    wc.emit('console-message', { message: line(), frame })
    menus.choose(1, 2)
    expect(frame.scripts.at(-1)).toBe(`globalThis.__podSelectFrameChoose?.("${doc}", 4, 2)`)
    expect(wc.scripts).toHaveLength(1)
    menus.noteClick(150, 220)
    wc.emit('console-message', { message: line(), frame })
    frame.detached = true
    menus.choose(2, 0)
    expect(frame.scripts).toHaveLength(2)
  })
})
