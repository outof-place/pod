// Fork-only (Pod): cancelPodPaneDownload, the cancel of one-app's native panes.
import { beforeEach, describe, expect, it, vi } from 'vitest'

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
  BrowserWindow: { fromWebContents: browserMocks.browserWindowFromWebContentsMock },
  clipboard: { writeText: vi.fn() },
  shell: { openExternal: browserMocks.shellOpenExternalMock },
  Menu: { buildFromTemplate: browserMocks.menuBuildFromTemplateMock },
  screen: { getCursorScreenPoint: browserMocks.screenGetCursorScreenPointMock },
  webContents: { fromId: browserMocks.webContentsFromIdMock }
}))

vi.mock('./popup-origin-bar-window', () => ({
  openPopupWithOriginBar: browserMocks.openPopupWithOriginBarMock
}))

import { browserManager } from './browser-manager'
import {
  createDownloadItem,
  rendererWebContentsId,
  resetBrowserManagerMocks,
  resetBrowserManagerState
} from './browser-manager-test-harness'
import {
  setPodBrowserPaneHooks,
  type PodBrowserDownloadEvent
} from '../pod/browser-pane/pod-browser-pane-hooks'

const { webContentsFromIdMock } = browserMocks

function guest(id: number) {
  return {
    id,
    isDestroyed: vi.fn(() => false),
    getType: vi.fn(() => 'window'),
    setBackgroundThrottling: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    getURL: vi.fn(() => 'https://example.com/')
  }
}

describe('browserManager.cancelPodPaneDownload', () => {
  let events: PodBrowserDownloadEvent[]

  beforeEach(() => {
    resetBrowserManagerMocks(browserMocks)
    resetBrowserManagerState()
    events = []
    setPodBrowserPaneHooks({
      agentCommand: vi.fn(),
      download: (event) => {
        events.push(event)
      },
      openLink: vi.fn(() => false),
      passkey: vi.fn(() => null)
    })
    return () => setPodBrowserPaneHooks(null)
  })

  function startOffscreenDownload(): { item: Electron.DownloadItem; downloadId: string } {
    const page = guest(711)
    webContentsFromIdMock.mockImplementation((id: number) => (id === page.id ? page : null))
    expect(
      browserManager.registerOffscreenGuest({ browserPageId: 'pane-1', webContentsId: page.id })
    ).toBe(true)
    const item = createDownloadItem()
    browserManager.handleGuestWillDownload({ guestWebContentsId: page.id, item })
    const requested = events.find((event) => event.kind === 'requested')
    expect(requested).toMatchObject({ browserPageId: 'pane-1', filename: 'report.csv' })
    return { item, downloadId: requested!.downloadId }
  }

  it('cancels a download of a page no renderer hosts and reports it canceled', () => {
    const { item, downloadId } = startOffscreenDownload()

    expect(browserManager.cancelPodPaneDownload({ browserPageId: 'pane-1', downloadId })).toBe(true)

    expect(item.cancel).toHaveBeenCalledTimes(1)
    expect(events.at(-1)).toMatchObject({
      kind: 'finished',
      browserPageId: 'pane-1',
      downloadId,
      status: 'canceled',
      error: 'Canceled.'
    })
    // Gone once finished: a second cancel finds nothing.
    expect(browserManager.cancelPodPaneDownload({ browserPageId: 'pane-1', downloadId })).toBe(
      false
    )
  })

  it("refuses another page's download and an unknown id", () => {
    const { item, downloadId } = startOffscreenDownload()

    expect(browserManager.cancelPodPaneDownload({ browserPageId: 'pane-2', downloadId })).toBe(
      false
    )
    expect(
      browserManager.cancelPodPaneDownload({ browserPageId: 'pane-1', downloadId: 'nope' })
    ).toBe(false)
    expect(item.cancel).not.toHaveBeenCalled()
  })

  it("refuses a download of a page a renderer hosts: that is the renderer owner's cancel", () => {
    const rendererSend = vi.fn()
    const page = { ...guest(712), getType: vi.fn(() => 'webview') }
    webContentsFromIdMock.mockImplementation((id: number) => {
      if (id === page.id) {
        return page
      }
      if (id === rendererWebContentsId) {
        return { isDestroyed: vi.fn(() => false), send: rendererSend }
      }
      return null
    })
    browserManager.attachGuestPolicies(page as never)
    browserManager.registerGuest({
      browserPageId: 'tab-1',
      webContentsId: page.id,
      rendererWebContentsId
    })
    const item = createDownloadItem()
    browserManager.handleGuestWillDownload({ guestWebContentsId: page.id, item })
    const downloadId = rendererSend.mock.calls.find(
      ([channel]) => channel === 'browser:download-requested'
    )?.[1].downloadId as string
    expect(downloadId).toEqual(expect.any(String))

    expect(browserManager.cancelPodPaneDownload({ browserPageId: 'tab-1', downloadId })).toBe(
      false
    )
    expect(item.cancel).not.toHaveBeenCalled()
    expect(events).toEqual([])
  })
})
