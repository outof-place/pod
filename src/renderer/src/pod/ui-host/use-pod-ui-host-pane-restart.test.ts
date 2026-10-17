import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'

const mount = vi.hoisted(() => vi.fn())
vi.mock('@/components/terminal/background-terminal-worktree-mount', () => ({
  requestBackgroundTerminalWorktreeMount: mount
}))

const store = vi.hoisted(() => {
  const sleepingAgentSessionsByPaneKey: Record<string, SleepingAgentSessionRecord> = {}
  const terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot> = {}
  const ptyIdsByTabId: Record<string, string[]> = {}
  return {
    sleepingAgentSessionsByPaneKey,
    terminalLayoutsByTabId,
    ptyIdsByTabId,
    clearTabPtyId: vi.fn((tabId: string, ptyId: string) => {
      ptyIdsByTabId[tabId] = (ptyIdsByTabId[tabId] ?? []).filter((id) => id !== ptyId)
    }),
    clearSleepingAgentSessionsByPaneKey: vi.fn((paneKeys: readonly string[]) => {
      for (const paneKey of paneKeys) {
        delete sleepingAgentSessionsByPaneKey[paneKey]
      }
    }),
    setTabLayout: vi.fn((tabId: string, layout: TerminalLayoutSnapshot) => {
      terminalLayoutsByTabId[tabId] = layout
    })
  }
})
vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))

const {
  forgetPodPaneAgentResume,
  registerPodPaneRestarter,
  restartPodPane,
  subscribePodUiHostPaneRestart
} = await import('./use-pod-ui-host-pane-restart')

const LEFT = '11111111-1111-4111-8111-111111111111'
const RIGHT = '22222222-2222-4222-8222-222222222222'

function record(paneKey: string, tabId: string): SleepingAgentSessionRecord {
  return {
    paneKey,
    tabId,
    worktreeId: 'wt',
    agent: 'claude',
    providerSession: { key: 'session_id', id: `session-${paneKey}` },
    prompt: 'fix it',
    state: 'working',
    capturedAt: 1,
    updatedAt: 1,
    origin: 'live'
  }
}

beforeEach(() => {
  mount.mockClear()
  for (const key of Object.keys(store.sleepingAgentSessionsByPaneKey)) {
    delete store.sleepingAgentSessionsByPaneKey[key]
  }
  for (const key of Object.keys(store.terminalLayoutsByTabId)) {
    delete store.terminalLayoutsByTabId[key]
  }
  for (const key of Object.keys(store.ptyIdsByTabId)) {
    delete store.ptyIdsByTabId[key]
  }
  store.clearTabPtyId.mockClear()
})

describe('restartPodPane (Pod)', () => {
  it('lets a mounted tab restart its own leaf, its agent resume dropped first', () => {
    store.sleepingAgentSessionsByPaneKey[`tab-a:${LEFT}`] = record(`tab-a:${LEFT}`, 'tab-a')
    const restarter = vi.fn(() => Object.keys(store.sleepingAgentSessionsByPaneKey).length === 0)
    const unregister = registerPodPaneRestarter('tab-a', restarter)
    expect(restartPodPane({ worktreeId: 'wt', tabId: 'tab-a', leafId: LEFT })).toBe(true)
    expect(restarter).toHaveBeenCalledWith(LEFT)
    expect(mount).not.toHaveBeenCalled()
    unregister()
  })

  it('mounts a tab this window has no pane for, without the dead binding or the agent resume', () => {
    store.terminalLayoutsByTabId['tab-b'] = {
      root: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: LEFT },
        second: { type: 'leaf', leafId: RIGHT }
      },
      activeLeafId: LEFT,
      expandedLeafId: null,
      ptyIdsByLeafId: { [LEFT]: 'pty-dead', [RIGHT]: 'pty-live' }
    }
    store.sleepingAgentSessionsByPaneKey[`tab-b:${LEFT}`] = record(`tab-b:${LEFT}`, 'tab-b')
    store.sleepingAgentSessionsByPaneKey[`tab-b:${RIGHT}`] = record(`tab-b:${RIGHT}`, 'tab-b')

    expect(restartPodPane({ worktreeId: 'wt', tabId: 'tab-b', leafId: LEFT })).toBe(true)

    expect(mount).toHaveBeenCalledWith({ worktreeId: 'wt', tabIds: ['tab-b'] })
    // Why: with neither, the mount's spawn has nothing to reattach to or resume: a plain shell.
    expect(store.terminalLayoutsByTabId['tab-b']?.ptyIdsByLeafId).toEqual({ [RIGHT]: 'pty-live' })
    expect(Object.keys(store.sleepingAgentSessionsByPaneKey)).toEqual([`tab-b:${RIGHT}`])
  })

  it("drops a one-pane tab's dead PTY on the tab itself, and only that one", () => {
    store.ptyIdsByTabId['tab-f'] = ['pty-dead']
    store.ptyIdsByTabId['tab-g'] = ['pty-live']

    restartPodPane({ worktreeId: 'wt', tabId: 'tab-f', leafId: LEFT, deadPtyId: 'pty-dead' })
    restartPodPane({ worktreeId: 'wt', tabId: 'tab-g', leafId: LEFT, deadPtyId: 'pty-dead' })

    expect(store.clearTabPtyId).toHaveBeenCalledTimes(1)
    expect(store.ptyIdsByTabId['tab-f']).toEqual([])
    expect(store.ptyIdsByTabId['tab-g']).toEqual(['pty-live'])
  })

  it("keeps a remount's restarter when the old mount unregisters", () => {
    const first = vi.fn(() => true)
    const second = vi.fn(() => false)
    const unregisterFirst = registerPodPaneRestarter('tab-c', first)
    registerPodPaneRestarter('tab-c', second)
    unregisterFirst()
    expect(restartPodPane({ worktreeId: 'wt', tabId: 'tab-c', leafId: 'gone' })).toBe(false)
    expect(second).toHaveBeenCalledWith('gone')
    expect(first).not.toHaveBeenCalled()
  })
})

describe('forgetPodPaneAgentResume (Pod)', () => {
  it("drops a one-pane tab's legacy numeric records, never another tab's or worktree's", () => {
    store.terminalLayoutsByTabId['tab-d'] = {
      root: { type: 'leaf', leafId: LEFT },
      activeLeafId: LEFT,
      expandedLeafId: null
    }
    store.sleepingAgentSessionsByPaneKey['tab-d:1'] = record('tab-d:1', 'tab-d')
    store.sleepingAgentSessionsByPaneKey['tab-e:1'] = record('tab-e:1', 'tab-e')
    store.sleepingAgentSessionsByPaneKey['tab-d:2'] = {
      ...record('tab-d:2', 'tab-d'),
      worktreeId: 'other'
    }

    forgetPodPaneAgentResume({ worktreeId: 'wt', tabId: 'tab-d', leafId: LEFT })

    expect(Object.keys(store.sleepingAgentSessionsByPaneKey).sort()).toEqual(['tab-d:2', 'tab-e:1'])
  })
})

describe('subscribePodUiHostPaneRestart (Pod)', () => {
  it('takes the panes main kept before this window subscribed', async () => {
    store.sleepingAgentSessionsByPaneKey[`tab-h:${LEFT}`] = record(`tab-h:${LEFT}`, 'tab-h')
    const stop = vi.fn()
    const podUiHost = {
      onPaneRestart: vi.fn(() => stop),
      onPaneExitRetained: vi.fn(() => stop),
      listRetainedPaneExits: vi.fn(async () => [{ worktreeId: 'wt', tabId: 'tab-h', leafId: LEFT }])
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the subscription calls only these three members.
    const unsubscribe = subscribePodUiHostPaneRestart(podUiHost as never)
    await vi.waitFor(() => expect(store.sleepingAgentSessionsByPaneKey).toEqual({}))
    unsubscribe()
    expect(stop).toHaveBeenCalledTimes(2)
  })
})
