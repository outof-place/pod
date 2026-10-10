// Fork-only (Pod): <select> menus for offscreen pages. On macOS Chromium opens a select through a
// native menu, which an offscreen page never gets, so the select just doesn't open. A script in an
// isolated world takes the select's mousedown, reports its options in a console message carrying a
// nonce only that world knows, and PodNative shows a native menu; the choice comes back here.
import { randomBytes } from 'node:crypto'
import type { WebContents } from 'electron'

// An isolated world of Pod's own; the page's scripts can't reach it.
const SELECT_WORLD_ID = 1987
const MESSAGE_PREFIX = '\u0000pod-select '
const MAX_ITEMS = 1000
const MAX_LABEL = 500

export type PaneSelectMenu = {
  menuId: number
  x: number
  y: number
  width: number
  height: number
  items: { label: string; enabled: boolean; selected: boolean; group: string }[]
}

function shim(nonce: string): string {
  return `(() => {
  if (globalThis.__podSelectMenus) return
  globalThis.__podSelectMenus = true
  let seq = 0
  const open = new Map()
  document.addEventListener('mousedown', (event) => {
    const select = event.target instanceof Element ? event.target.closest('select') : null
    if (!select || select.multiple || select.size > 1 || select.disabled || event.button !== 0) return
    event.preventDefault()
    select.focus()
    const rect = select.getBoundingClientRect()
    const items = [...select.options].slice(0, ${MAX_ITEMS}).map((option) => ({
      label: String(option.label || option.text).slice(0, ${MAX_LABEL}),
      enabled: !option.disabled && !(option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled),
      selected: option.selected,
      group: option.parentElement instanceof HTMLOptGroupElement ? String(option.parentElement.label).slice(0, ${MAX_LABEL}) : ''
    }))
    const menuId = ++seq
    open.set(menuId, select)
    console.debug(${JSON.stringify(MESSAGE_PREFIX)} + ${JSON.stringify(nonce)} + ' ' + JSON.stringify({ menuId, x: rect.left, y: rect.top, width: rect.width, height: rect.height, items }))
  }, true)
  globalThis.__podSelectChoose = (menuId, index) => {
    const select = open.get(menuId)
    open.delete(menuId)
    if (!select || index < 0 || index >= select.options.length || select.selectedIndex === index) return
    select.selectedIndex = index
    select.dispatchEvent(new Event('input', { bubbles: true }))
    select.dispatchEvent(new Event('change', { bubbles: true }))
  }
})()`
}

function finite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** One page's select menus: the script on every load, and its menus read back from the console. */
export class PaneSelectMenus {
  private readonly nonce = randomBytes(16).toString('hex')

  constructor(
    private readonly wc: WebContents,
    onMenu: (menu: PaneSelectMenu) => void
  ) {
    wc.on('dom-ready', () => {
      void wc.executeJavaScriptInIsolatedWorld(SELECT_WORLD_ID, [{ code: shim(this.nonce) }])
    })
    wc.on('console-message', (details) => {
      const menu = this.parse(details.message)
      if (menu) {
        onMenu(menu)
      }
    })
  }

  /** The menu's line, or null for anything else (including the page trying to sound like it). */
  parse(message: string): PaneSelectMenu | null {
    const head = `${MESSAGE_PREFIX}${this.nonce} `
    if (!message.startsWith(head)) {
      return null
    }
    let value: unknown
    try {
      value = JSON.parse(message.slice(head.length))
    } catch {
      return null
    }
    if (
      typeof value !== 'object' ||
      value === null ||
      !('menuId' in value) ||
      !('items' in value)
    ) {
      return null
    }
    const { menuId, items } = value
    if (typeof menuId !== 'number' || !Number.isInteger(menuId) || !Array.isArray(items)) {
      return null
    }
    return {
      menuId,
      x: 'x' in value ? finite(value.x) : 0,
      y: 'y' in value ? finite(value.y) : 0,
      width: 'width' in value ? finite(value.width) : 0,
      height: 'height' in value ? finite(value.height) : 0,
      items: items.slice(0, MAX_ITEMS).map((item: unknown) => {
        const record = typeof item === 'object' && item !== null ? item : {}
        return {
          label: 'label' in record ? String(record.label).slice(0, MAX_LABEL) : '',
          enabled: 'enabled' in record && record.enabled === true,
          selected: 'selected' in record && record.selected === true,
          group: 'group' in record ? String(record.group).slice(0, MAX_LABEL) : ''
        }
      })
    }
  }

  /** PodNative's pick (or -1 to close the menu unchanged). */
  choose(menuId: number, index: number): void {
    void this.wc.executeJavaScriptInIsolatedWorld(SELECT_WORLD_ID, [
      { code: `globalThis.__podSelectChoose?.(${Math.trunc(menuId)}, ${Math.trunc(index)})` }
    ])
  }
}
