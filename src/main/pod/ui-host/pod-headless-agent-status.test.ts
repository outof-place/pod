import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const listeners: ((event: Record<string, unknown>) => void)[] = []
  const state: { mainWindow: { isDestroyed: () => boolean } | null } = { mainWindow: null }
  return { listeners, state, rename: vi.fn() }
})

vi.mock('../../agent-hooks/server', () => ({
  agentHookServer: {
    subscribeEnrichedStatus: (listener: (event: Record<string, unknown>) => void) => {
      mocks.listeners.push(listener)
      return () => mocks.listeners.splice(mocks.listeners.indexOf(listener), 1)
    }
  }
}))
vi.mock('../../startup/branch-rename-hook', () => ({
  maybeAutoRenameBranchOnFirstWorkFromHook: mocks.rename
}))
vi.mock('../../startup/main-process-state', () => ({ mainProcessState: mocks.state }))

import { installPodHeadlessAgentStatus } from './pod-headless-agent-status'

const working = {
  paneKey: 'tab:leaf',
  tabId: 'tab',
  worktreeId: 'repo::/w',
  connectionId: null,
  payload: { state: 'working', prompt: 'fix the login bug' }
}

function emit(event: Record<string, unknown>): void {
  for (const listener of mocks.listeners) {
    listener(event)
  }
}

beforeEach(() => {
  mocks.listeners.length = 0
  mocks.state.mainWindow = null
  mocks.rename.mockReset()
})

describe('installPodHeadlessAgentStatus', () => {
  it('renames the branch on first work while no window is open', () => {
    installPodHeadlessAgentStatus()
    emit(working)
    expect(mocks.rename).toHaveBeenCalledWith({
      paneKey: 'tab:leaf',
      tabId: 'tab',
      worktreeId: 'repo::/w',
      payload: working.payload,
      isReplay: undefined
    })
  })

  it('leaves it to an open window, and skips what the window listener skips', () => {
    installPodHeadlessAgentStatus()
    mocks.state.mainWindow = { isDestroyed: () => false }
    emit(working)
    mocks.state.mainWindow = { isDestroyed: () => true }
    emit({ ...working, restoredUnconfirmed: true })
    emit({ ...working, providerSessionOnly: true })
    emit({ ...working, structuredHost: { kind: 'claude' } })
    expect(mocks.rename).not.toHaveBeenCalled()
  })

  it('stops once uninstalled', () => {
    const uninstall = installPodHeadlessAgentStatus()
    uninstall()
    emit(working)
    expect(mocks.rename).not.toHaveBeenCalled()
  })
})
