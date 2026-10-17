// Fork-only (Pod): <select> menus for offscreen pages. On macOS Chromium opens a select through a
// native menu, which an offscreen page never gets, so the select just doesn't open. A script in an
// isolated world takes the select's mousedown, reports its options in a console message carrying a
// nonce only that world knows, and PodNative shows a native menu; the choice comes back here.
// An iframe's document has no isolated world of Pod's (WebFrameMain runs scripts in the main world
// only), so its script's message is trusted by the frame it came from, once per user click and
// right after it.
import { randomBytes } from 'node:crypto'
import type { WebContents, WebFrameMain } from 'electron'

// An isolated world of Pod's own; the page's scripts can't reach it.
const SELECT_WORLD_ID = 1987
const MESSAGE_PREFIX = '\u0000pod-select '
const FRAME_MESSAGE_PREFIX = '\u0000pod-select-frame '
// How long after the user's own click into the page an iframe's menu still counts as its answer.
const FRAME_CLICK_MS = 1_000
const MAX_ITEMS = 1000
const MAX_LABEL = 500
// Menus PodNative may still answer; it shows one at a time.
const MAX_OPEN_MENUS = 8

export type PaneSelectMenu = {
  menuId: number
  x: number
  y: number
  width: number
  height: number
  items: { label: string; enabled: boolean; selected: boolean; group: string }[]
}

// The select's options and box, as both scripts read them on its mousedown.
const READ_SELECT = `const select = event.target instanceof Element ? event.target.closest('select') : null
    if (!select || select.multiple || select.size > 1 || select.disabled || event.button !== 0) return
    event.preventDefault()
    select.focus()
    const rect = select.getBoundingClientRect()
    const items = [...select.options].slice(0, ${MAX_ITEMS}).map((option) => ({
      label: String(option.label || option.text).slice(0, ${MAX_LABEL}),
      enabled: !option.disabled && !(option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled),
      selected: option.selected,
      group: option.parentElement instanceof HTMLOptGroupElement ? String(option.parentElement.label).slice(0, ${MAX_LABEL}) : ''
    }))`

const CHOOSE = `const select = open.get(menuId)
    open.delete(menuId)
    if (!select || index < 0 || index >= select.options.length || select.selectedIndex === index) return
    select.selectedIndex = index
    select.dispatchEvent(new Event('input', { bubbles: true }))
    select.dispatchEvent(new Event('change', { bubbles: true }))`

function shim(nonce: string): string {
  return `(() => {
  if (globalThis.__podSelectMenus) return
  globalThis.__podSelectMenus = true
  let seq = 0
  const open = new Map()
  document.addEventListener('mousedown', (event) => {
    ${READ_SELECT}
    const menuId = ++seq
    open.set(menuId, select)
    console.debug(${JSON.stringify(MESSAGE_PREFIX)} + ${JSON.stringify(nonce)} + ' ' + JSON.stringify({ menuId, x: rect.left, y: rect.top, width: rect.width, height: rect.height, items }))
  }, true)
  globalThis.__podSelectChoose = (menuId, index) => {
    ${CHOOSE}
  }
})()`
}

// An iframe's: `doc` tells its document from the next one in the same frame. Untrusted clicks
// (a script's) open nothing.
function frameShim(doc: string): string {
  return `(() => {
  if (globalThis.__podSelectFrameChoose) return
  const doc = ${JSON.stringify(doc)}
  let seq = 0
  const open = new Map()
  document.addEventListener('mousedown', (event) => {
    if (!event.isTrusted) return
    ${READ_SELECT}
    const menuId = ++seq
    open.clear()
    open.set(menuId, select)
    console.debug(${JSON.stringify(FRAME_MESSAGE_PREFIX)} + JSON.stringify({ doc, menuId, clientX: event.clientX, clientY: event.clientY, x: rect.left, y: rect.top, width: rect.width, height: rect.height, items }))
  }, true)
  globalThis.__podSelectFrameChoose = (fromDoc, menuId, index) => {
    if (fromDoc !== doc) return
    ${CHOOSE}
  }
})()`
}

type MenuRoute =
  | { frame: null; menuId: number }
  | { frame: WebFrameMain; doc: string; menuId: number }

function finite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** One page's select menus: the script on every load, and its menus read back from the console. */
export class PaneSelectMenus {
  private readonly nonce = randomBytes(16).toString('hex')
  // PodNative's menu ids, each to the frame and the script's own id it answers.
  private readonly routes = new Map<number, MenuRoute>()
  private seq = 0
  // The user's last click into the page (view px), which one iframe menu may answer.
  private click: { x: number; y: number; at: number } | null = null

  constructor(
    private readonly wc: WebContents,
    private readonly onMenu: (menu: PaneSelectMenu) => void
  ) {
    wc.on('dom-ready', () => {
      void wc.executeJavaScriptInIsolatedWorld(SELECT_WORLD_ID, [{ code: shim(this.nonce) }])
    })
    wc.on('frame-created', (_event, { frame }) => {
      // The top frame has the isolated world above.
      if (frame && frame.parent !== null) {
        frame.on('dom-ready', () => this.injectFrame(frame))
      }
    })
    wc.on('console-message', (details) => {
      // Why read now: a frame accessed later may already be the next document's, or null.
      const { frame } = details
      if (frame && frame.parent !== null) {
        this.frameMessage(frame, details.message)
        return
      }
      const menu = this.parse(details.message)
      if (menu) {
        this.open({ frame: null, menuId: menu.menuId }, menu)
      }
    })
  }

  /** A left mouse-down the user sent the page, at view coordinates. */
  noteClick(x: number, y: number): void {
    this.click = { x, y, at: Date.now() }
  }

  private injectFrame(frame: WebFrameMain): void {
    if (frame.isDestroyed() || frame.detached) {
      return
    }
    frame.executeJavaScript(frameShim(randomBytes(8).toString('hex'))).catch(() => undefined)
  }

  private frameMessage(frame: WebFrameMain, message: string): void {
    if (!message.startsWith(FRAME_MESSAGE_PREFIX) || frame.detached) {
      return
    }
    const click = this.click
    // Once per click of the user's own, and only right after it: the frame's script is the page's.
    if (!click || Date.now() - click.at > FRAME_CLICK_MS) {
      return
    }
    const value = parseJson(message.slice(FRAME_MESSAGE_PREFIX.length))
    if (!value || !('doc' in value) || typeof value.doc !== 'string') {
      return
    }
    const { doc } = value
    const menu = readMenu(value)
    if (!menu || !/^[0-9a-f]{16}$/.test(doc)) {
      return
    }
    this.click = null
    const clientX = 'clientX' in value ? finite(value.clientX) : 0
    const clientY = 'clientY' in value ? finite(value.clientY) : 0
    // The click in the page's CSS px, which the frame's numbers are in.
    const zoom = this.wc.getZoomFactor()
    const x = click.x / zoom
    const y = click.y / zoom
    // The frame's box on the page, from where the same click landed in each.
    const rect = { x: menu.x + x - clientX, y: menu.y + y - clientY, width: menu.width, height: menu.height }
    const holdsClick =
      x >= rect.x - 1 && x <= rect.x + rect.width + 1 && y >= rect.y - 1 && y <= rect.y + rect.height + 1
    // A transformed frame moves its box: the menu then opens at the click.
    const box = holdsClick ? rect : { x, y, width: 0, height: 0 }
    this.open({ frame, doc, menuId: menu.menuId }, { ...menu, ...box })
  }

  private open(route: MenuRoute, menu: PaneSelectMenu): void {
    const menuId = ++this.seq
    this.routes.set(menuId, route)
    const oldest = this.routes.keys().next().value
    if (this.routes.size > MAX_OPEN_MENUS && oldest !== undefined) {
      this.routes.delete(oldest)
    }
    // CSS px to the page view's, the space PodNative places the menu in.
    const zoom = this.wc.getZoomFactor()
    this.onMenu({
      ...menu,
      menuId,
      x: menu.x * zoom,
      y: menu.y * zoom,
      width: menu.width * zoom,
      height: menu.height * zoom
    })
  }

  /** The menu's line, or null for anything else (including the page trying to sound like it). */
  parse(message: string): PaneSelectMenu | null {
    const head = `${MESSAGE_PREFIX}${this.nonce} `
    if (!message.startsWith(head)) {
      return null
    }
    const value = parseJson(message.slice(head.length))
    return value ? readMenu(value) : null
  }

  /** PodNative's pick (or -1 to close the menu unchanged). */
  choose(menuId: number, index: number): void {
    const route = this.routes.get(menuId)
    this.routes.delete(menuId)
    if (!route) {
      return
    }
    const pick = Math.trunc(index)
    if (route.frame === null) {
      void this.wc.executeJavaScriptInIsolatedWorld(SELECT_WORLD_ID, [
        { code: `globalThis.__podSelectChoose?.(${route.menuId}, ${pick})` }
      ])
      return
    }
    const { frame } = route
    if (frame.isDestroyed() || frame.detached) {
      return
    }
    frame
      .executeJavaScript(
        `globalThis.__podSelectFrameChoose?.(${JSON.stringify(route.doc)}, ${route.menuId}, ${pick})`
      )
      .catch(() => undefined)
  }
}

function parseJson(text: string): object | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  return typeof value === 'object' && value !== null ? value : null
}

function readMenu(value: object): PaneSelectMenu | null {
  if (!('menuId' in value) || !('items' in value)) {
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
