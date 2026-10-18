// PaneCobrowse on a fake page, for its tests: the deps a pane gives it, and the pushes it sent.
import { vi } from 'vitest'
import { PaneCobrowse } from './pod-browser-cobrowse'
import { FakePage, type Element, type Frame } from './pod-browser-cobrowse-fake-page.test-support'
import type { PodBrowserCobrowseServerMessage } from './pod-browser-cobrowse-protocol'

export { READ_ONLY, type Element, type Frame } from './pod-browser-cobrowse-fake-page.test-support'

export function setup(
  elements: Element[],
  options: {
    watching?: boolean
    zoom?: number
    url?: string
    frames?: Record<string, Frame>
  } = {}
) {
  // Each test its own copy, so one that fails leaves the next a whole page.
  const page = new FakePage(
    elements.map((e) => ({ ...e, box: { ...e.box } })),
    options.zoom ?? 1
  )
  page.frames = { ...options.frames }
  const sent: PodBrowserCobrowseServerMessage[] = []
  const capture = vi.fn(async (_clip: Record<string, number>) => 'iVBORw0KGgo=')
  // The page's debugger: held from the first CDP sender handed out until released.
  const lease = { held: false, takes: 0 }
  const release = vi.fn(() => {
    lease.held = false
  })
  let ids = 0
  const cobrowse = new PaneCobrowse({
    pageId: 'page-1',
    cdp: () => {
      if (!lease.held) {
        lease.held = true
        lease.takes += 1
      }
      return page.cdp
    },
    releaseCdp: release,
    capture,
    send: (message) => sent.push(message),
    attached: () => true,
    paneShown: () => true,
    page: () => ({
      url: options.url ?? 'http://localhost:5173/settings',
      title: 'Settings'
    }),
    zoom: () => page.zoom,
    now: () => new Date('2026-10-18T12:00:00Z'),
    randomId: () => `pointer-${++ids}`
  })
  if (options.watching !== false) {
    cobrowse.setWatching(true)
  }
  const state = () => sent.findLast((m) => m.type === 'browserCobrowseState')
  const refused = () => sent.filter((m) => m.type === 'browserMarkRefused')
  return { page, sent, cobrowse, capture, release, state, lease, refused }
}

export const SAVE: Element = {
  id: 7,
  tag: 'button',
  selector: 'button#save',
  text: 'Save',
  box: { x: 100, y: 900, width: 80, height: 30 }
}
export const FORM: Element = {
  id: 3,
  tag: 'form',
  selector: 'form.settings',
  text: 'Settings',
  box: { x: 0, y: 0, width: 1000, height: 2000 }
}
export const MARK_ID = '6c1f7f0e-9a3b-4c2d-8e1f-0a1b2c3d4e5f'

// Lets the paint-scheduled geometry read (one CDP round trip chain) finish.
export const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
