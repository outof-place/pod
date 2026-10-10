import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { PaneSelectMenus } from './pod-browser-pane-select'

class FakeWebContents extends EventEmitter {
  readonly scripts: { world: number; code: string }[] = []
  executeJavaScriptInIsolatedWorld = vi.fn(async (world: number, sources: { code: string }[]) => {
    this.scripts.push(...sources.map(({ code }) => ({ world, code })))
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
    expect(onMenu).toHaveBeenCalledWith(menu)
  })

  it('hands the pick to its world', () => {
    const { wc, menus } = setup()
    menus.choose(3, 1)
    expect(wc.scripts.at(-1)).toEqual({ world: 1987, code: 'globalThis.__podSelectChoose?.(3, 1)' })
  })
})
