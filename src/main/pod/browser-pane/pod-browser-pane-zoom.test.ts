import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { PaneZoom } from './pod-browser-pane-zoom'
import type { PaneInputAction } from './pod-browser-pane-input'

class FakeWebContents extends EventEmitter {
  level = 0
  getZoomLevel = () => this.level
  setZoomLevel = vi.fn((level: number) => {
    this.level = level
  })
}

function setup(seed?: number) {
  const wc = new FakeWebContents()
  const changed = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake has every member PaneZoom calls.
  const zoom = new PaneZoom(wc as unknown as Electron.WebContents, seed, changed)
  return { wc, zoom, changed }
}

const wheel = (deltaY: number, modifiers: ('control' | 'shift')[]): PaneInputAction => ({
  kind: 'send',
  input: {
    type: 'mouseWheel',
    x: 10,
    y: 10,
    deltaX: 0,
    deltaY,
    hasPreciseScrollingDeltas: true,
    canScroll: true,
    modifiers
  }
})

describe('PaneZoom', () => {
  it("starts at Pod's default and puts the page's own level back on every load", () => {
    const { wc } = setup(1.5)
    wc.emit('dom-ready')
    expect(wc.level).toBe(1.5)
    // Another page of the host moved it.
    wc.level = -1
    wc.emit('dom-ready')
    expect(wc.level).toBe(1.5)
    // Why compare first: no write when the page already has its level.
    wc.emit('dom-ready')
    expect(wc.setZoomLevel).toHaveBeenCalledTimes(2)
  })

  it('steps from its own level, resets to 100%, and reports each change', () => {
    const { wc, zoom, changed } = setup(1)
    wc.level = 3
    zoom.step('in')
    expect(wc.level).toBe(1.5)
    zoom.step('reset')
    expect(wc.level).toBe(0)
    expect(changed).toHaveBeenCalledTimes(2)
  })

  it('zooms on a ⌃ scroll and leaves every other input alone', () => {
    const { wc, zoom } = setup()
    expect(zoom.takesWheel(wheel(-4, ['control']))).toBe(true)
    expect(wc.level).toBe(0.5)
    expect(zoom.takesWheel(wheel(-4, []))).toBe(false)
    expect(zoom.takesWheel(wheel(-4, ['control', 'shift']))).toBe(false)
    expect(zoom.takesWheel({ kind: 'insertText', text: 'a' })).toBe(false)
  })
})
