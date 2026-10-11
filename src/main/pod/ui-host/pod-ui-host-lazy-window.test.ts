import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, ((event: { sender: { id: number } }) => void)[]>()
  return {
    handlers,
    ipcMain: {
      on: vi.fn((channel: string, handler: (event: { sender: { id: number } }) => void) => {
        handlers.set(channel, [...(handlers.get(channel) ?? []), handler])
      }),
      removeListener: vi.fn((channel: string, handler: unknown) => {
        handlers.set(
          channel,
          (handlers.get(channel) ?? []).filter((entry) => entry !== handler)
        )
      })
    }
  }
})

vi.mock('electron', () => ({ ipcMain: mocks.ipcMain }))

import {
  PodUiHostLazyWindow,
  type PodUiHostLazyWindowDeps,
  type PodUiHostLazyWindowTarget
} from './pod-ui-host-lazy-window'

type FakeWindow = PodUiHostLazyWindowTarget & { destroyed: boolean }

function fakeWindow(id: number): FakeWindow {
  const window: FakeWindow = {
    destroyed: false,
    isDestroyed: () => window.destroyed,
    webContents: { id }
  }
  return window
}

let window: FakeWindow | null = null
let nextId = 40
const lazies: PodUiHostLazyWindow<string>[] = []

function lazy(
  overrides: Partial<PodUiHostLazyWindowDeps<string>> = {}
): PodUiHostLazyWindow<string> & { deps: PodUiHostLazyWindowDeps<string> } {
  const deps: PodUiHostLazyWindowDeps<string> = {
    getWindow: () => window,
    canOpen: () => true,
    openWindow: vi.fn(() => {
      window = fakeWindow(++nextId)
    }),
    present: vi.fn(),
    refuse: vi.fn(),
    log: vi.fn(),
    ...overrides
  }
  const instance = new PodUiHostLazyWindow(deps)
  lazies.push(instance)
  return Object.assign(instance, { deps })
}

function ready(id: number): void {
  for (const handler of mocks.handlers.get('pod:uiHostSurface:ready') ?? []) {
    handler({ sender: { id } })
  }
}

beforeEach(() => {
  window = null
  mocks.handlers.clear()
})

afterEach(() => {
  for (const instance of lazies.splice(0)) {
    instance.dispose()
  }
  vi.useRealTimers()
})

describe('PodUiHostLazyWindow', () => {
  it('opens one window and carries out the latest request once its renderer is ready', () => {
    const subject = lazy()
    subject.request('first')
    subject.request('second')
    expect(subject.deps.openWindow).toHaveBeenCalledTimes(1)
    ready(1)
    expect(subject.deps.present).not.toHaveBeenCalled()
    ready(window!.webContents.id)
    expect(subject.deps.present).toHaveBeenCalledTimes(1)
    expect(subject.deps.present).toHaveBeenCalledWith('second')
    subject.request('third')
    expect(subject.deps.present).toHaveBeenLastCalledWith('third')
  })

  it('opens a new window after the last one closed, and waits for that renderer', () => {
    const subject = lazy()
    subject.request('a')
    ready(window!.webContents.id)
    window!.destroyed = true
    subject.request('b')
    expect(subject.deps.openWindow).toHaveBeenCalledTimes(2)
    expect(subject.deps.present).toHaveBeenCalledTimes(1)
    ready(window!.webContents.id)
    expect(subject.deps.present).toHaveBeenLastCalledWith('b')
  })

  it('refuses when no window may open', () => {
    const subject = lazy({ canOpen: () => false })
    subject.request('a')
    expect(subject.deps.refuse).toHaveBeenCalledWith('a')
    expect(subject.deps.openWindow).not.toHaveBeenCalled()
  })

  it('shows the window anyway when its renderer never says it is ready', () => {
    vi.useFakeTimers()
    const subject = lazy({ readyTimeoutMs: 1_000 })
    subject.request('a')
    vi.advanceTimersByTime(999)
    expect(subject.deps.present).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(subject.deps.present).toHaveBeenCalledWith('a')
  })

  it('drops a waiting request whose window closed before it was ready', () => {
    vi.useFakeTimers()
    const subject = lazy({ readyTimeoutMs: 1_000 })
    subject.request('a')
    window!.destroyed = true
    vi.advanceTimersByTime(1_000)
    expect(subject.deps.present).not.toHaveBeenCalled()
  })

  it('stops listening once disposed', () => {
    const subject = lazy()
    subject.dispose()
    expect(mocks.handlers.get('pod:uiHostSurface:ready')).toEqual([])
  })
})
