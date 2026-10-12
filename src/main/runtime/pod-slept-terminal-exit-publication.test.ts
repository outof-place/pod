// Fork-only (Pod): a slept terminal's exit publishes its tab pending. Close Terminals with the
// one-app window open stops the panes reversibly (the tab and its wake binding stay); the exit
// republished the worktree's tabs before it marked the renderer's leaf disconnected, so that frame
// still carried the dead terminal's handle as ready. When no later frame came (gate 4, round 1:
// the exit landed after the window's sleep had republished), PodNative showed a dead terminal as
// ready until the next sleep.
import { withDurableRuntimeStore } from './runtime-durable-store-fixture'
import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { OrcaRuntimeService } from './orca-runtime'

const WORKTREE_ID = 'repo::/worktree'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const LIVE_REPO = {
  id: 'repo',
  path: '/worktree',
  displayName: 'repo',
  badgeColor: 'blue',
  addedAt: 1
} as const

function makeSnapshot(): RuntimeMobileSessionTabsSnapshot {
  return {
    worktree: WORKTREE_ID,
    publicationEpoch: 'renderer',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: `tab::${LEAF_ID}`,
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal',
        id: `tab::${LEAF_ID}`,
        parentTabId: 'tab',
        leafId: LEAF_ID,
        ptyId: 'pty-left',
        title: 'Left',
        parentLayout: {
          root: { type: 'leaf' as const, leafId: LEAF_ID },
          activeLeafId: LEAF_ID,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF_ID]: 'pty-left' }
        },
        isActive: true
      }
    ]
  }
}

function makePersistedSession(): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [WORKTREE_ID]: [
        {
          id: 'tab',
          ptyId: 'pty-left',
          worktreeId: WORKTREE_ID,
          title: 'Terminal',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {
      tab: {
        root: { type: 'leaf' as const, leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: 'pty-left' }
      }
    }
  }
}

function createHost(): { runtime: OrcaRuntimeService; handle: string } {
  let session = makePersistedSession()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the store stub carries the four members this publication-order suite drives; the rest of Store is unreached.
  const runtime = new OrcaRuntimeService(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This runtime fixture supplies the persistence and graph methods exercised by the test.
    withDurableRuntimeStore({
      getRepos: () => [LIVE_REPO],
      getWorkspaceSession: () => session,
      setWorkspaceSession: (next: WorkspaceSessionState) => {
        session = next
      },
      flushOrThrow: vi.fn()
    }) as never
  )
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: 'tab',
        worktreeId: WORKTREE_ID,
        title: 'Terminal',
        activeLeafId: LEAF_ID,
        layout: { type: 'leaf', leafId: LEAF_ID }
      }
    ],
    leaves: [
      {
        tabId: 'tab',
        worktreeId: WORKTREE_ID,
        leafId: LEAF_ID,
        paneRuntimeId: 1,
        ptyId: 'pty-left'
      }
    ],
    mobileSessionTabs: [makeSnapshot()]
  })
  runtime.registerPty('pty-left', WORKTREE_ID, null, {
    tabId: 'tab',
    leafId: LEAF_ID,
    incarnationId: 'incarnation-a'
  })
  // The mirror binds panes by terminal handle, so the handle has to exist before the close.
  const handle = runtime.preAllocateHandleForPty('pty-left')
  runtime.registerPreAllocatedHandleForPty('pty-left', handle)
  return { runtime, handle }
}

function shownTab(frame: RuntimeMobileSessionTabsResult) {
  const tab = frame.tabs.find((candidate) => candidate.type === 'terminal')
  return tab?.type === 'terminal' ? { status: tab.status, terminal: tab.terminal } : null
}

describe("a slept terminal's exit", () => {
  it("publishes its tab pending in the exit's own frame", async () => {
    const { runtime, handle } = createHost()
    expect(shownTab(await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`))).toEqual({
      status: 'ready',
      terminal: handle
    })
    const frames: RuntimeMobileSessionTabsResult[] = []
    const unsubscribe = runtime.onMobileSessionTabsChanged(
      (frame) => frames.push(frame),
      'podnative'
    )
    // As the sleep marks it: a reversible stop keeps the tab and its wake binding.
    const settle = runtime.intentionalPtyStops.mark('pty-left', 'reversible', 'incarnation-a')
    try {
      await runtime.onPtyExit('pty-left', 0, 'incarnation-a', { providerExitObserved: true })
      settle(true)
    } finally {
      unsubscribe()
    }

    expect(frames.length).toBeGreaterThan(0)
    expect(frames.map(shownTab)).toEqual(
      frames.map(() => ({ status: 'pending-handle', terminal: null }))
    )
    expect(shownTab(await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`))).toEqual({
      status: 'pending-handle',
      terminal: null
    })
  })
})
