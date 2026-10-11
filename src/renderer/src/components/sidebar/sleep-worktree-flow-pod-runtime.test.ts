import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const order: string[] = []
  const activeWorktreeId: string | null = null
  const state = {
    activeWorktreeId,
    setActiveWorktree: vi.fn(),
    shutdownWorktreeBrowsers: vi.fn().mockResolvedValue(undefined),
    shutdownWorktreeTerminals: vi.fn(async () => {
      order.push('renderer panes')
    })
  }
  const sleepRuntimeTerminals = vi.fn(async (worktreeId: string) => {
    order.push(`runtime ${worktreeId}`)
  })
  const beginRuntimeSleep = vi.fn((worktreeId: string) => {
    order.push(`begin ${worktreeId}`)
  })
  return { order, state, beginRuntimeSleep, sleepRuntimeTerminals, toastError: vi.fn() }
})

vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))
vi.mock('@/lib/worktree-sleep-intent', () => ({
  clearWorktreeSleepIntent: vi.fn(),
  markWorktreeSleepIntent: vi.fn(),
  withWorktreeSleepTeardown: (_worktreeId: string, teardown: () => Promise<unknown>) => teardown()
}))

import { runSleepWorktree } from './sleep-worktree-flow'

describe('Close Terminals in the one-app window', () => {
  beforeEach(() => {
    mocks.order.length = 0
    mocks.sleepRuntimeTerminals.mockClear()
    mocks.toastError.mockClear()
    vi.unstubAllGlobals()
  })

  it('holds the worktree first, then has the runtime sleep the PTYs no pane bound', async () => {
    vi.stubGlobal('window', {
      api: {
        podUiHost: {
          beginRuntimeSleep: mocks.beginRuntimeSleep,
          sleepRuntimeTerminals: mocks.sleepRuntimeTerminals
        }
      },
      requestAnimationFrame: vi.fn()
    })
    await runSleepWorktree('wt-1')
    expect(mocks.order).toEqual(['begin wt-1', 'renderer panes', 'runtime wt-1'])
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('keeps the workspace awake and says so when the runtime could not sleep them', async () => {
    mocks.sleepRuntimeTerminals.mockRejectedValueOnce(new Error('terminal_stop_unverified'))
    vi.stubGlobal('window', {
      api: {
        podUiHost: {
          beginRuntimeSleep: mocks.beginRuntimeSleep,
          sleepRuntimeTerminals: mocks.sleepRuntimeTerminals
        }
      },
      requestAnimationFrame: vi.fn()
    })
    await runSleepWorktree('wt-1')
    expect(mocks.toastError).toHaveBeenCalledOnce()
  })

  it('needs no one-app bridge (web client, other launches)', async () => {
    vi.stubGlobal('window', { api: {}, requestAnimationFrame: vi.fn() })
    await runSleepWorktree('wt-1')
    expect(mocks.order).toEqual(['renderer panes'])
  })
})
