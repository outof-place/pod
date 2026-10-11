import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  holdWindowAwakeAtStartup,
  leaseAwaitedRendererRequests,
  podUiHostMainWindowOptions,
  STARTUP_AWAKE_AFTER_LOAD_MS
} from './ui-host-hidden-renderer'

describe('podUiHostMainWindowOptions', () => {
  it('starts the one-app main window hidden while panes own browser pages', () => {
    expect(podUiHostMainWindowOptions(true, {}, true)).toEqual({ paintWhenInitiallyHidden: false })
  })

  it('keeps the window painting when asked, when pages are webviews, and in every other launch', () => {
    expect(podUiHostMainWindowOptions(true, { POD_UI_HOST_RENDERER_VISIBLE: '1' }, true)).toEqual(
      {}
    )
    expect(podUiHostMainWindowOptions(true, {}, false)).toEqual({})
    expect(podUiHostMainWindowOptions(false, {}, true)).toEqual({})
  })
})

describe('holdWindowAwakeAtStartup', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const startupWindow = () => {
    const listeners: { load?: () => void; destroyed?: () => void } = {}
    return {
      listeners,
      target: { setBackgroundThrottling: vi.fn(), capturePage: vi.fn(() => Promise.resolve(null)) },
      lifecycle: {
        onFirstLoad: vi.fn((listener: () => void) => {
          listeners.load = listener
        }),
        onDestroyed: vi.fn((listener: () => void) => {
          listeners.destroyed = listener
        })
      }
    }
  }

  it('holds a lease from creation until the wake window after the first load ends', () => {
    const window = startupWindow()
    const release = vi.fn()
    const leases = { acquire: vi.fn(() => release) }
    holdWindowAwakeAtStartup(window.target, window.lifecycle, true, leases)
    expect(leases.acquire).toHaveBeenCalledWith(window.target)
    vi.advanceTimersByTime(STARTUP_AWAKE_AFTER_LOAD_MS * 2)
    expect(release).not.toHaveBeenCalled()
    window.listeners.load?.()
    vi.advanceTimersByTime(STARTUP_AWAKE_AFTER_LOAD_MS - 1)
    expect(release).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('releases when the window goes before its wake window ends', () => {
    const window = startupWindow()
    const release = vi.fn()
    holdWindowAwakeAtStartup(window.target, window.lifecycle, true, { acquire: () => release })
    window.listeners.load?.()
    window.listeners.destroyed?.()
    expect(release).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(STARTUP_AWAKE_AFTER_LOAD_MS)
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('leaves a window that does not start hidden alone', () => {
    const window = startupWindow()
    const leases = { acquire: vi.fn(() => () => {}) }
    holdWindowAwakeAtStartup(window.target, window.lifecycle, false, leases)
    expect(leases.acquire).not.toHaveBeenCalled()
    expect(window.lifecycle.onFirstLoad).not.toHaveBeenCalled()
  })
})

describe('leaseAwaitedRendererRequests', () => {
  const target = {
    setBackgroundThrottling: vi.fn(),
    capturePage: vi.fn(() => Promise.resolve(null))
  }

  it('holds a lease while an awaited request is pending, through success and failure', async () => {
    const release = vi.fn()
    const leases = { acquire: vi.fn(() => release) }
    let finish: () => void = () => {}
    let fail: (error: Error) => void = () => {}
    const notifier = leaseAwaitedRendererRequests(
      target,
      {
        closeTab: (id: string) =>
          new Promise<string>((resolve) => {
            finish = () => resolve(id)
          }),
        readTab: () =>
          new Promise<void>((_resolve, reject) => {
            fail = reject
          })
      },
      true,
      leases
    )
    const closed = notifier.closeTab('t1')
    expect(leases.acquire).toHaveBeenCalledWith(target)
    expect(release).not.toHaveBeenCalled()
    finish()
    await expect(closed).resolves.toBe('t1')
    expect(release).toHaveBeenCalledTimes(1)

    const read = notifier.readTab()
    fail(new Error('gone'))
    await expect(read).rejects.toThrow('gone')
    expect(release).toHaveBeenCalledTimes(2)
  })

  it('leaves plain sends asleep, and every other launch unwrapped', () => {
    const leases = { acquire: vi.fn(() => () => {}) }
    const send = vi.fn(() => undefined)
    const notifier = leaseAwaitedRendererRequests(target, { send }, true, leases)
    notifier.send()
    expect(send).toHaveBeenCalledTimes(1)
    expect(leases.acquire).not.toHaveBeenCalled()

    const plain = { send }
    expect(leaseAwaitedRendererRequests(target, plain, false, leases).send).toBe(send)
  })
})
