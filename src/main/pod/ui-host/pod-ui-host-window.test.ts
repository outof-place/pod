import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const windows: { isVisible: () => boolean }[] = []
  const sent: unknown[] = []
  return {
    app: { hide: vi.fn() },
    windows,
    sent,
    attached: { value: true },
    uiHost: { value: true },
    headless: { value: true }
  }
})

vi.mock('electron', () => ({
  app: mocks.app,
  BrowserWindow: { getAllWindows: () => mocks.windows }
}))
vi.mock('./pod-ui-host-bridge', () => ({
  sendToPodUi: (message: unknown) => {
    mocks.sent.push(message)
    return mocks.attached.value
  }
}))
vi.mock('./pod-ui-host-launch', () => ({
  isPodUiHostLaunch: () => mocks.uiHost.value,
  isPodHeadlessUiHost: () => mocks.headless.value
}))

import { HEADLESS_RUNTIME_WINDOW_ID } from '../../../shared/runtime-types'
import {
  hidePodUiHostWindowOnClose,
  notePodHeadlessWindowClosed,
  requestPodHeadlessQuit
} from './pod-ui-host-window'

function closingWindow(): { hide: () => void; isDestroyed: () => boolean } {
  return { hide: vi.fn(), isDestroyed: () => false }
}

beforeEach(() => {
  mocks.windows.length = 0
  mocks.sent.length = 0
  mocks.attached.value = true
  mocks.uiHost.value = true
  mocks.headless.value = true
  vi.clearAllMocks()
})

describe('the headless one-app window', () => {
  it('closes for real instead of hiding', () => {
    const window = closingWindow()
    expect(hidePodUiHostWindowOnClose(window, false)).toBe(false)
    expect(window.hide).not.toHaveBeenCalled()
  })

  it('republishes the runtime graph once closed, and hands the foreground back', () => {
    const runtime = { syncWindowGraph: vi.fn() }
    notePodHeadlessWindowClosed(runtime)
    expect(runtime.syncWindowGraph).toHaveBeenCalledWith(HEADLESS_RUNTIME_WINDOW_ID, {
      tabs: [],
      leaves: []
    })
    expect(mocks.app.hide).toHaveBeenCalled()
    expect(mocks.sent).toEqual([{ type: 'surfaceHidden' }])
  })

  it('asks PodNative to quit Pod on a user Quit, while one is attached', () => {
    expect(requestPodHeadlessQuit()).toBe(true)
    expect(mocks.sent).toEqual([{ type: 'quitRequested', reason: 'user' }])
    mocks.attached.value = false
    expect(requestPodHeadlessQuit()).toBe(false)
  })
})

describe('the hidden-window one-app runtime', () => {
  beforeEach(() => {
    mocks.headless.value = false
  })

  it('hides on close and keeps its graph', () => {
    const window = closingWindow()
    const runtime = { syncWindowGraph: vi.fn() }
    expect(hidePodUiHostWindowOnClose(window, false)).toBe(true)
    expect(window.hide).toHaveBeenCalled()
    notePodHeadlessWindowClosed(runtime)
    expect(runtime.syncWindowGraph).not.toHaveBeenCalled()
    expect(requestPodHeadlessQuit()).toBe(false)
  })
})
