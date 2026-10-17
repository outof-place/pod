import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-session-contracts'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../shared/runtime-types'
import {
  getPodTerminalExit,
  listPodTerminalExits,
  podRetainsFailedLocalExit,
  recordPodTerminalExit,
  resetPodTerminalExitsForTests,
  withPodTerminalExits
} from './pod-terminal-exits'
import {
  restartPodExitedTerminal,
  setPodRendererPaneRestart,
  type PodTerminalRestartHost
} from './pod-terminal-exit-restart'

afterEach(() => {
  resetPodTerminalExitsForTests()
  setPodRendererPaneRestart(null)
})

const surface = { worktreeId: 'wt', parentTabId: 'tab', leafId: 'left' }
const exit = { exitCode: 2, exitedAt: 1_000 }

describe('which exits keep the pane (Pod)', () => {
  const failed = { exitCode: 1, local: true, operatorClose: false, processDeathCertified: true }
  it.each([
    ['a failed local shell', failed, true],
    ['a clean exit', { ...failed, exitCode: 0 }, false],
    ['an unconfirmed stop', { ...failed, exitCode: -1 }, false],
    ['an SSH shell', { ...failed, local: false }, false],
    ['a close the user asked for', { ...failed, operatorClose: true }, false],
    ['an exit nobody certified', { ...failed, processDeathCertified: false }, false]
  ])('%s: %s', (_label, input, kept) => {
    expect(podRetainsFailedLocalExit(input)).toBe(kept)
  })
})

describe('withPodTerminalExits (Pod)', () => {
  function result(status: 'pending-handle' | 'ready'): RuntimeMobileSessionTabsResult {
    const base = {
      type: 'terminal' as const,
      id: 'tab::left',
      parentTabId: 'tab',
      leafId: 'left',
      title: 'Left',
      isActive: true
    }
    return {
      worktree: 'wt',
      publicationEpoch: 'renderer',
      snapshotVersion: 1,
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null,
      tabs: [
        status === 'ready'
          ? { ...base, status: 'ready', terminal: 'term_1' }
          : { ...base, status: 'pending-handle', terminal: null }
      ]
    }
  }

  it('shows the exit on the kept pane only while it has no live handle', () => {
    expect(withPodTerminalExits(result('pending-handle')).tabs[0]).not.toHaveProperty(
      'terminalExit'
    )
    recordPodTerminalExit(surface, exit)
    expect(withPodTerminalExits(result('pending-handle')).tabs[0]).toMatchObject({
      terminalExit: exit
    })
    expect(withPodTerminalExits(result('ready')).tabs[0]).not.toHaveProperty('terminalExit')
    expect(
      withPodTerminalExits({ ...result('pending-handle'), worktree: 'other' }).tabs[0]
    ).not.toHaveProperty('terminalExit')
  })
})

describe('restartPodExitedTerminal (Pod)', () => {
  function host(overrides: Partial<PodTerminalRestartHost> = {}) {
    const snapshot: RuntimeMobileSessionTabsSnapshot = {
      worktree: 'wt',
      publicationEpoch: 'headless',
      snapshotVersion: 1,
      activeGroupId: 'group',
      activeTabId: 'tab::left',
      activeTabType: 'terminal',
      tabGroups: [{ id: 'group', activeTabId: 'tab', tabOrder: ['tab'] }],
      tabs: [
        {
          type: 'terminal',
          id: 'tab::left',
          parentTabId: 'tab',
          leafId: 'left',
          title: 'Left',
          startupCwd: '/work/tree',
          isActive: true
        }
      ]
    }
    const finish = vi.fn()
    const create = vi.fn<PodTerminalRestartHost['createRuntimeOwnedMobileSessionTerminal']>(
      async () => ({
        tab: {
          type: 'terminal',
          id: 'tab::left',
          parentTabId: 'tab',
          leafId: 'left',
          title: 'Left',
          isActive: true,
          status: 'ready',
          terminal: 'term_new'
        },
        publicationEpoch: 'headless',
        snapshotVersion: 2
      })
    )
    const value: PodTerminalRestartHost = {
      getValidatedExplicitWorktreeIdSelector: () => 'wt',
      resolveWorktreeSelector: async () => ({ id: 'wt' }),
      hydrateHeadlessMobileSessionTabsFromWorkspaceSession: () => {},
      refreshMobileSessionPtyRecords: async () => {},
      mobileSessionTabsByWorktree: new Map([['wt', snapshot]]),
      joinPaneMaterialization: () => null,
      beginPaneMaterialization: () => finish,
      getAvailableAuthoritativeWindow: () => null,
      getMobileSessionTabsForWorktree: () => {
        throw new Error('headless restarts never wait on the window')
      },
      createRuntimeOwnedMobileSessionTerminal: create,
      ...overrides
    }
    return { value, create, finish }
  }

  it('starts a plain shell in the same pane and folder, and clears the exit', async () => {
    recordPodTerminalExit(surface, exit)
    const { value, create, finish } = host()

    await expect(restartPodExitedTerminal(value, 'id:wt', 'tab', 'left')).resolves.toEqual({
      terminal: 'term_new'
    })
    expect(create).toHaveBeenCalledWith('wt', false, undefined, {
      identity: { tabId: 'tab', leafId: 'left' },
      cwd: '/work/tree',
      targetGroupId: 'group'
    })
    expect(getPodTerminalExit('wt', 'tab', 'left')).toBeUndefined()
    expect(finish).toHaveBeenCalledTimes(1)
  })

  it('refuses a pane that did not fail, and one already restarting', async () => {
    const { value, create } = host()
    await expect(restartPodExitedTerminal(value, 'id:wt', 'tab::left')).rejects.toThrow(
      'terminal_not_exited'
    )
    recordPodTerminalExit(surface, exit)
    const busy = host({ joinPaneMaterialization: () => Promise.resolve() })
    await expect(restartPodExitedTerminal(busy.value, 'id:wt', 'tab::left')).rejects.toThrow(
      'terminal_restart_in_progress'
    )
    await expect(restartPodExitedTerminal(value, 'id:wt', 'missing')).rejects.toThrow(
      'tab_not_found'
    )
    expect(create).not.toHaveBeenCalled()
  })

  it('keeps the exit when the restart fails, so Restart stays on offer', async () => {
    recordPodTerminalExit(surface, exit)
    const { value, finish } = host({
      createRuntimeOwnedMobileSessionTerminal: async () => {
        throw new Error('spawn failed')
      }
    })
    await expect(restartPodExitedTerminal(value, 'id:wt', 'tab::left')).rejects.toThrow(
      'spawn failed'
    )
    expect(getPodTerminalExit('wt', 'tab', 'left')).toEqual(exit)
    expect(finish).toHaveBeenCalledTimes(1)
  })

  describe('with a window', () => {
    function leafTab(ready: boolean): RuntimeMobileSessionTabsResult {
      const base = {
        type: 'terminal' as const,
        id: 'tab::left',
        parentTabId: 'tab',
        leafId: 'left',
        title: 'Left',
        isActive: true
      }
      return {
        worktree: 'wt',
        publicationEpoch: 'renderer',
        snapshotVersion: 1,
        activeGroupId: null,
        activeTabId: null,
        activeTabType: null,
        tabs: [
          ready
            ? { ...base, status: 'ready', terminal: 'term_window' }
            : { ...base, status: 'pending-handle', terminal: null }
        ]
      }
    }

    it("has the window's renderer start the shell, then answers the leaf's new handle", async () => {
      recordPodTerminalExit(surface, exit)
      const restart = vi.fn(async () => true)
      setPodRendererPaneRestart(restart)
      let polls = 0
      const { value, create } = host({
        getAvailableAuthoritativeWindow: () => ({ window: 1 }),
        getMobileSessionTabsForWorktree: () => leafTab(++polls > 2)
      })

      await expect(restartPodExitedTerminal(value, 'id:wt', 'tab', 'left')).resolves.toEqual({
        terminal: 'term_window'
      })
      expect(restart).toHaveBeenCalledWith(
        { window: 1 },
        { worktreeId: 'wt', tabId: 'tab', leafId: 'left' }
      )
      expect(create).not.toHaveBeenCalled()
    })

    it('names the exited PTY, so the window drops a binding its mount would reattach to', async () => {
      recordPodTerminalExit(surface, exit)
      const restart = vi.fn(async () => true)
      setPodRendererPaneRestart(restart)
      const { value } = host({
        getAvailableAuthoritativeWindow: () => ({ window: 1 }),
        getMobileSessionTabsForWorktree: () => leafTab(true)
      })
      const kept = value.mobileSessionTabsByWorktree.get('wt')
      const withDeadPty: PodTerminalRestartHost = {
        ...value,
        mobileSessionTabsByWorktree: new Map([
          [
            'wt',
            {
              ...kept!,
              tabs: kept!.tabs.map((tab) => ({ ...tab, ptyId: 'pty-dead' }))
            }
          ]
        ])
      }

      await restartPodExitedTerminal(withDeadPty, 'id:wt', 'tab', 'left')
      expect(restart).toHaveBeenCalledWith(
        { window: 1 },
        { worktreeId: 'wt', tabId: 'tab', leafId: 'left', deadPtyId: 'pty-dead' }
      )
    })

    it('keeps the exit when the renderer refuses the restart', async () => {
      recordPodTerminalExit(surface, exit)
      setPodRendererPaneRestart(async () => false)
      const { value } = host({ getAvailableAuthoritativeWindow: () => ({ window: 1 }) })

      await expect(restartPodExitedTerminal(value, 'id:wt', 'tab::left')).rejects.toThrow(
        'terminal_restart_failed'
      )
      expect(getPodTerminalExit('wt', 'tab', 'left')).toEqual(exit)
    })
  })
})

describe('listPodTerminalExits (Pod)', () => {
  it('lists every kept pane, for a window that subscribed late', () => {
    recordPodTerminalExit(surface, exit)
    recordPodTerminalExit({ worktreeId: 'wt2', parentTabId: 'tab2', leafId: 'right' }, exit)
    expect(listPodTerminalExits()).toEqual([
      { worktreeId: 'wt', tabId: 'tab', leafId: 'left' },
      { worktreeId: 'wt2', tabId: 'tab2', leafId: 'right' }
    ])
  })
})
