import { describe, expect, it } from 'vitest'
import { isNavigablePaneUrl, PaneInputState } from './pod-browser-pane-input'
import type { PodBrowserInputEvent } from './pod-browser-pane-protocol'

const mouse = (action: 'down' | 'up' | 'move'): PodBrowserInputEvent => ({
  kind: 'mouse',
  action,
  x: 10.6,
  y: 20.2,
  button: 'left',
  clickCount: 1,
  modifiers: []
})
const key = (
  action: 'down' | 'up' | 'char',
  keyCode: string,
  modifiers: ('meta' | 'shift')[] = []
): PodBrowserInputEvent => ({ kind: 'key', action, keyCode, modifiers })

describe('PaneInputState', () => {
  it('rounds mouse coordinates and marks a drag with the held button', () => {
    const input = new PaneInputState()
    expect(input.map(mouse('down'))).toEqual({
      kind: 'send',
      input: { type: 'mouseDown', x: 11, y: 20, button: 'left', clickCount: 1, modifiers: [] }
    })
    expect(input.map(mouse('move'))).toMatchObject({ input: { modifiers: ['leftbuttondown'] } })
    input.map(mouse('up'))
    expect(input.map(mouse('move'))).toMatchObject({ input: { modifiers: [] } })
  })

  it('passes precise scrolling as pixels and turns wheel lines into pixels and ticks', () => {
    const input = new PaneInputState()
    const wheel = (deltaY: number, precise: boolean): PodBrowserInputEvent => ({
      kind: 'wheel',
      x: 1,
      y: 2,
      deltaX: 0,
      deltaY,
      precise,
      modifiers: []
    })
    expect(input.map(wheel(-12.5, true))).toMatchObject({
      input: { type: 'mouseWheel', deltaY: -12.5, hasPreciseScrollingDeltas: true, canScroll: true }
    })
    expect(input.map(wheel(1, false))).toMatchObject({
      input: { deltaY: 40, wheelTicksY: 1, hasPreciseScrollingDeltas: false }
    })
  })

  it("names modifiers the way Electron's input events take them", () => {
    const input = new PaneInputState()
    expect(
      input.map({
        kind: 'key',
        action: 'down',
        keyCode: 'A',
        modifiers: ['shift', 'capsLock', 'isAutoRepeat']
      })
    ).toMatchObject({
      input: { type: 'keyDown', modifiers: ['shift', 'capslock', 'isautorepeat'] }
    })
  })

  it('turns ⌘C, ⌘V, ⌘A, ⌘Z and ⇧⌘Z into edit commands and swallows their key-ups', () => {
    const input = new PaneInputState()
    expect(input.map(key('down', 'c', ['meta']))).toEqual({ kind: 'edit', command: 'copy' })
    expect(input.map(key('char', 'c', ['meta']))).toEqual({ kind: 'none' })
    expect(input.map(key('up', 'c', ['meta']))).toEqual({ kind: 'none' })
    expect(input.map(key('down', 'V', ['meta']))).toEqual({ kind: 'edit', command: 'paste' })
    expect(input.map(key('down', 'a', ['meta']))).toEqual({ kind: 'edit', command: 'selectAll' })
    expect(input.map(key('down', 'z', ['meta', 'shift']))).toEqual({
      kind: 'edit',
      command: 'redo'
    })
    // Anything else with ⌘ is the page's (⌘K in a web app).
    expect(input.map(key('down', 'k', ['meta']))).toMatchObject({ kind: 'send' })
    expect(input.map(key('up', 'x'))).toMatchObject({ kind: 'send', input: { type: 'keyUp' } })
  })

  it('inserts committed text as text', () => {
    expect(new PaneInputState().map({ kind: 'text', text: 'żółw' })).toEqual({
      kind: 'insertText',
      text: 'żółw'
    })
  })
})

describe('isNavigablePaneUrl', () => {
  it('takes http(s) and about:blank only', () => {
    expect(isNavigablePaneUrl('https://example.com/a?b')).toBe(true)
    expect(isNavigablePaneUrl('http://localhost:3000')).toBe(true)
    expect(isNavigablePaneUrl('about:blank')).toBe(true)
    for (const url of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'data:text/html,x',
      'pod://x',
      'nope'
    ]) {
      expect(isNavigablePaneUrl(url)).toBe(false)
    }
  })
})
