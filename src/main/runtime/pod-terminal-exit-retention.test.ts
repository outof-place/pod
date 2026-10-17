import { withDurableRuntimeStore } from './runtime-durable-store-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { OrcaRuntimeService } from './orca-runtime'
import { resetPodTerminalExitsForTests } from '../pod/terminal-exit/pod-terminal-exits'

// Fork-only (Pod): a local shell that fails keeps its pane with its exit; one that ends cleanly,
// or an SSH one, retires as before.
const REPO_ID = 'repo'
const WORKTREE_ID = `${REPO_ID}::/work/tree`
const LEFT = 'pty-left'
const RIGHT = 'pty-right'
const REPO = {
  id: REPO_ID,
  path: '/work/tree',
  displayName: 'repo',
  badgeColor: 'blue',
  addedAt: 1
}
const parentLayout = {
  root: {
    type: 'split' as const,
    direction: 'vertical' as const,
    first: { type: 'leaf' as const, leafId: 'left' },
    second: { type: 'leaf' as const, leafId: 'right' }
  },
  activeLeafId: 'left',
  expandedLeafId: null,
  ptyIdsByLeafId: { left: LEFT, right: RIGHT }
}

function snapshot(): RuntimeMobileSessionTabsSnapshot {
  return {
    worktree: WORKTREE_ID,
    publicationEpoch: 'renderer',
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
        ptyId: LEFT,
        title: 'Left',
        startupCwd: '/work/tree',
        parentLayout,
        isActive: true
      },
      {
        type: 'terminal',
        id: 'tab::right',
        parentTabId: 'tab',
        leafId: 'right',
        ptyId: RIGHT,
        title: 'Right',
        parentLayout,
        isActive: false
      }
    ]
  }
}

function session(): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [WORKTREE_ID]: [
        {
          id: 'tab',
          ptyId: LEFT,
          worktreeId: WORKTREE_ID,
          title: 'Terminal',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: { tab: parentLayout }
  }
}

function runtimeWithSplit(): OrcaRuntimeService {
  let stored = session()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This runtime fixture supplies the persistence and graph methods exercised by the test.
  const store = withDurableRuntimeStore({
    getRepos: () => [REPO],
    getRepo: (id: string) => (id === REPO_ID ? REPO : undefined),
    getWorkspaceSession: () => stored,
    setWorkspaceSession: (next: WorkspaceSessionState) => {
      stored = next
    },
    flushOrThrow: vi.fn()
  }) as never
  const runtime = new OrcaRuntimeService(store)
  runtime.attachWindow(1)
  const published = snapshot()
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: 'tab',
        worktreeId: WORKTREE_ID,
        title: 'Terminal',
        activeLeafId: 'left',
        layout: parentLayout.root
      }
    ],
    leaves: [
      { tabId: 'tab', worktreeId: WORKTREE_ID, leafId: 'left', paneRuntimeId: 1, ptyId: LEFT },
      { tabId: 'tab', worktreeId: WORKTREE_ID, leafId: 'right', paneRuntimeId: 2, ptyId: RIGHT }
    ],
    mobileSessionTabs: [published]
  })
  runtime.registerPty(LEFT, WORKTREE_ID, null, {
    tabId: 'tab',
    leafId: 'left',
    incarnationId: 'incarnation-a'
  })
  return runtime
}

afterEach(() => resetPodTerminalExitsForTests())

describe('a failed local shell keeps its pane (Pod)', () => {
  it('keeps the pane with its exit code when the shell exits above 0', async () => {
    const runtime = runtimeWithSplit()
    const before = Date.now()
    await runtime.onPtyExit(LEFT, 1, 'incarnation-a')

    const tabs = (await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)).tabs
    expect(tabs.map((tab) => tab.id)).toEqual(['tab::left', 'tab::right'])
    const left = tabs[0]
    expect(left).toMatchObject({ status: 'pending-handle', terminal: null })
    expect(left?.type === 'terminal' ? left.terminalExit?.exitCode : null).toBe(1)
    expect(left?.type === 'terminal' ? left.terminalExit?.exitedAt : 0).toBeGreaterThanOrEqual(
      before
    )
    expect(tabs[1]).not.toHaveProperty('terminalExit')
  })

  it('retires the pane as before when the shell ends cleanly', async () => {
    const runtime = runtimeWithSplit()
    await runtime.onPtyExit(LEFT, 0, 'incarnation-a')

    const tabs = (await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)).tabs
    expect(tabs.map((tab) => tab.id)).toEqual(['tab::right'])
  })

  it('retires the pane when nobody could confirm the stop (-1)', async () => {
    const runtime = runtimeWithSplit()
    await runtime.onPtyExit(LEFT, -1, 'incarnation-a')

    const tabs = (await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)).tabs
    expect(tabs.map((tab) => tab.id)).toEqual(['tab::right'])
  })
})
