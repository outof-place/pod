// Fork-only (Pod): <select> menus for offscreen pages. On macOS Chromium opens a select through a
// native menu, which an offscreen page never gets, so the select just doesn't open. A script in an
// isolated world takes the select's mousedown, reports its options in a console message carrying a
// nonce only that world knows, and PodNative shows a native menu; the choice comes back here.
// An iframe's document has no isolated world of Pod's (WebFrameMain runs scripts in the main world
// only), so its script's message is trusted by the frame it came from, once per user click and
// right after it.
import { randomBytes } from 'node:crypto'
import type { WebContents, WebFrameMain } from 'electron'
import type { PodBrowserPaneServerMessage } from './pod-browser-pane-protocol'
import {
  encodePodUiHostServerMessage,
  POD_UI_HOST_MAX_LINE_BYTES
} from '../ui-host/pod-ui-host-protocol'

// An isolated world of Pod's own; the page's scripts can't reach it.
const SELECT_WORLD_ID = 1987
const MESSAGE_PREFIX = '\u0000pod-select '
const FRAME_MESSAGE_PREFIX = '\u0000pod-select-frame '
// How long after the user's own click into the page an iframe's menu still counts as its answer.
const FRAME_CLICK_MS = 1_000
const MAX_ITEMS = 1000
// Why fewer: an iframe's script runs in the page's world, so the page can write that menu.
const MAX_FRAME_ITEMS = 200
const MAX_LABEL = 500
// browserInput's bound. Why: a huge box times the page zoom is Infinity, which JSON writes as null.
const MAX_COORDINATE = 100_000
// Menus PodNative may still answer; it shows one at a time.
const MAX_OPEN_MENUS = 8

export type PodBrowserPopupMenu = Extract<PodBrowserPaneServerMessage, { type: 'browserPopupMenu' }>

export type PaneSelectMenu = Omit<PodBrowserPopupMenu, 'type' | 'pageId'>

type Box = { x: number; y: number; width: number; height: number }

// The select's options and box, as both scripts read them on its mousedown.
function readSelect(maxItems: number): string {
  return `const select = event.target instanceof Element ? event.target.closest('select') : null
    if (!select || select.multiple || select.size > 1 || select.disabled || event.button !== 0) return
    event.preventDefault()
    select.focus()
    const rect = select.getBoundingClientRect()
    const items = [...select.options].slice(0, ${maxItems}).map((option) => ({
      label: String(option.label || option.text).slice(0, ${MAX_LABEL}),
      enabled: !option.disabled && !(option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled),
      selected: option.selected,
      group: option.parentElement instanceof HTMLOptGroupElement ? String(option.parentElement.label).slice(0, ${MAX_LABEL}) : ''
    }))`
}

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
    ${readSelect(MAX_ITEMS)}
    const menuId = ++seq
    open.set(menuId, select)
    console.debug(${JSON.stringify(MESSAGE_PREFIX)} + ${JSON.stringify(nonce)} + ' ' + JSON.stringify({ menuId, x: rect.left, y: rect.top, width: rect.width, height: rect.height, items }))
  }, true)
  globalThis.__podSelectChoose = (menuId, index) => {
    ${CHOOSE}
  }
})()`
}

// An iframe's. `doc` names this document of the frame: a pick never reaches the frame's next one.
// isTrusted keeps a script's mousedown from using up the user's click. Neither is a boundary (the
// page can read `doc` and write this message itself); main trusts the user's click (frameMessage).
function frameShim(doc: string): string {
  return `(() => {
  if (globalThis.__podSelectFrameChoose) return
  const doc = ${JSON.stringify(doc)}
  let seq = 0
  const open = new Map()
  document.addEventListener('mousedown', (event) => {
    if (!event.isTrusted) return
    ${readSelect(MAX_FRAME_ITEMS)}
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

function coordinate(value: unknown, min = -MAX_COORDINATE): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(Math.max(value, min), MAX_COORDINATE)
    : 0
}

// The part of a box inside the page view, or null when none of it is.
function inView(box: Box, [width = 0, height = 0]: number[]): Box | null {
  const x = Math.max(box.x, 0)
  const y = Math.max(box.y, 0)
  const right = Math.min(box.x + box.width, width)
  const bottom = Math.min(box.y + box.height, height)
  return right >= x && bottom >= y ? { x, y, width: right - x, height: bottom - y } : null
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
    private readonly hooks: {
      pageId: string
      // The page view's [width, height].
      viewSize: () => number[]
      onMenu: (menu: PodBrowserPopupMenu) => void
    }
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
    if (!message.startsWith(FRAME_MESSAGE_PREFIX) || frame.isDestroyed() || frame.detached) {
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
    const menu = readMenu(value, MAX_FRAME_ITEMS)
    if (!menu || !/^[0-9a-f]{16}$/.test(doc)) {
      return
    }
    this.click = null
    const clientX = 'clientX' in value ? coordinate(value.clientX) : 0
    const clientY = 'clientY' in value ? coordinate(value.clientY) : 0
    // The frame's box on the page, from where the same click landed in each. Only its part in the
    // page view: the page writes this box, at any size.
    const rect = inView(
      {
        x: menu.x + click.x - clientX,
        y: menu.y + click.y - clientY,
        width: menu.width,
        height: menu.height
      },
      this.hooks.viewSize()
    )
    const holdsClick =
      rect !== null &&
      click.x >= rect.x - 1 &&
      click.x <= rect.x + rect.width + 1 &&
      click.y >= rect.y - 1 &&
      click.y <= rect.y + rect.height + 1
    // A transformed or zoomed frame moves its box: the menu then opens at the click.
    const box = holdsClick ? rect : { x: click.x, y: click.y, width: 0, height: 0 }
    this.open({ frame, doc, menuId: menu.menuId }, { ...menu, ...box })
  }

  private open(route: MenuRoute, menu: PaneSelectMenu): void {
    const menuId = ++this.seq
    const line = fitLine({ type: 'browserPopupMenu', pageId: this.hooks.pageId, ...menu, menuId })
    if (!line) {
      return
    }
    this.routes.set(menuId, route)
    const oldest = this.routes.keys().next().value
    if (this.routes.size > MAX_OPEN_MENUS && oldest !== undefined) {
      this.routes.delete(oldest)
    }
    this.hooks.onMenu(line)
  }

  /** The menu's line, or null for anything else (including the page trying to sound like it). */
  parse(message: string): PaneSelectMenu | null {
    const head = `${MESSAGE_PREFIX}${this.nonce} `
    if (!message.startsWith(head)) {
      return null
    }
    const value = parseJson(message.slice(head.length))
    return value ? readMenu(value, MAX_ITEMS) : null
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

// Why well formed: a lone surrogate encodes as \udXXX, which PodNative's JSONSerialization refuses.
// Why the check: never half a pair at the cut.
function label(value: unknown): string {
  const cut = String(value).toWellFormed().slice(0, MAX_LABEL)
  return /[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut
}

// The menu with as many of its first items as fit its line; null if none would. Why the line: past
// POD_UI_HOST_MAX_LINE_BYTES PodNative drops the channel, not just the menu. Why the first ones:
// PodNative's pick is an option's index.
function fitLine(menu: PodBrowserPopupMenu): PodBrowserPopupMenu | null {
  // The line without items, then each item's JSON and the comma before all but the first.
  let bytes = Buffer.byteLength(encodePodUiHostServerMessage({ ...menu, items: [] }))
  if (bytes > POD_UI_HOST_MAX_LINE_BYTES) {
    return null
  }
  let count = 0
  for (const item of menu.items) {
    bytes += Buffer.byteLength(JSON.stringify(item)) + (count > 0 ? 1 : 0)
    if (bytes > POD_UI_HOST_MAX_LINE_BYTES) {
      break
    }
    count += 1
  }
  return count === menu.items.length ? menu : { ...menu, items: menu.items.slice(0, count) }
}

function readMenu(value: object, maxItems: number): PaneSelectMenu | null {
  if (!('menuId' in value) || !('items' in value)) {
    return null
  }
  const { menuId, items } = value
  if (typeof menuId !== 'number' || !Number.isInteger(menuId) || !Array.isArray(items)) {
    return null
  }
  return {
    menuId,
    x: 'x' in value ? coordinate(value.x) : 0,
    y: 'y' in value ? coordinate(value.y) : 0,
    width: 'width' in value ? coordinate(value.width, 0) : 0,
    height: 'height' in value ? coordinate(value.height, 0) : 0,
    items: items.slice(0, maxItems).map((item: unknown) => {
      const record = typeof item === 'object' && item !== null ? item : {}
      return {
        label: 'label' in record ? label(record.label) : '',
        enabled: 'enabled' in record && record.enabled === true,
        selected: 'selected' in record && record.selected === true,
        group: 'group' in record ? label(record.group) : ''
      }
    })
  }
}
