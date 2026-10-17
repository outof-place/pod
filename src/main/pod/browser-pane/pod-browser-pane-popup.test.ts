import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const browserMocks = vi.hoisted(() => ({
  appGetPathMock: vi.fn(() => '/downloads'),
  shellOpenExternalMock: vi.fn(),
  browserWindowFromWebContentsMock: vi.fn(),
  menuBuildFromTemplateMock: vi.fn(),
  guestOffMock: vi.fn(),
  guestOnMock: vi.fn(),
  guestSetBackgroundThrottlingMock: vi.fn(),
  guestSetWindowOpenHandlerMock: vi.fn(),
  guestOpenDevToolsMock: vi.fn(),
  webContentsFromIdMock: vi.fn(),
  screenGetCursorScreenPointMock: vi.fn(() => ({ x: 0, y: 0 })),
  openPopupWithOriginBarMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: browserMocks.appGetPathMock },
  BrowserWindow: {
    fromWebContents: browserMocks.browserWindowFromWebContentsMock
  },
  clipboard: { writeText: vi.fn() },
  shell: { openExternal: browserMocks.shellOpenExternalMock },
  Menu: { buildFromTemplate: browserMocks.menuBuildFromTemplateMock },
  screen: { getCursorScreenPoint: browserMocks.screenGetCursorScreenPointMock },
  webContents: { fromId: browserMocks.webContentsFromIdMock }
}))

vi.mock('../../browser/popup-origin-bar-window', () => ({
  openPopupWithOriginBar: browserMocks.openPopupWithOriginBarMock
}))

import { browserManager } from '../../browser/browser-manager'
import {
  resetBrowserManagerMocks,
  resetBrowserManagerState
} from '../../browser/browser-manager-test-harness'
import { setPodBrowserPaneHooks } from './pod-browser-pane-hooks'

type OpenHandler = (details: {
  url: string
  frameName: string
  features: string
  disposition: string
}) => { action: 'allow' | 'deny' }

// A one-app page: an offscreen WebContents no renderer hosts, in a PodNative pane.
function offscreenPage(): OpenHandler {
  const guest = {
    id: 311,
    isDestroyed: vi.fn(() => false),
    getType: vi.fn(() => 'window'),
    setBackgroundThrottling: browserMocks.guestSetBackgroundThrottlingMock,
    setWindowOpenHandler: browserMocks.guestSetWindowOpenHandlerMock,
    on: browserMocks.guestOnMock,
    off: browserMocks.guestOffMock,
    openDevTools: browserMocks.guestOpenDevToolsMock
  }
  browserMocks.webContentsFromIdMock.mockImplementation((id: number) =>
    id === guest.id ? guest : null
  )
  browserManager.registerOffscreenGuest({
    browserPageId: 'page-1',
    webContentsId: guest.id
  })
  const handler: OpenHandler = browserMocks.guestSetWindowOpenHandlerMock.mock.calls[0][0]
  return handler
}

const link = {
  url: 'https://docs.example.com/guide',
  frameName: '',
  features: ''
}

describe("an offscreen page's new-tab links", () => {
  beforeEach(() => {
    resetBrowserManagerMocks(browserMocks)
    resetBrowserManagerState()
  })

  afterEach(() => {
    setPodBrowserPaneHooks(null)
  })

  it("go to PodNative's panes, as a tab would for a renderer, and never to a native window", () => {
    const openLink = vi.fn(() => true)
    setPodBrowserPaneHooks({
      agentCommand: vi.fn(),
      download: vi.fn(),
      openLink,
      passkey: vi.fn(() => null)
    })
    const handler = offscreenPage()
    expect(handler({ ...link, disposition: 'background-tab' })).toEqual({
      action: 'deny'
    })
    expect(handler({ ...link, disposition: 'foreground-tab' })).toEqual({
      action: 'deny'
    })
    expect(openLink.mock.calls).toEqual([
      ['page-1', link.url, false],
      ['page-1', link.url, true]
    ])
    expect(browserMocks.openPopupWithOriginBarMock).not.toHaveBeenCalled()
    expect(browserMocks.shellOpenExternalMock).not.toHaveBeenCalled()
  })

  it('open nothing without one-app panes, as before', () => {
    const handler = offscreenPage()
    expect(handler({ ...link, disposition: 'background-tab' })).toEqual({
      action: 'deny'
    })
    expect(browserMocks.openPopupWithOriginBarMock).not.toHaveBeenCalled()
    expect(browserMocks.shellOpenExternalMock).not.toHaveBeenCalled()
  })
})
