import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from './orca-runtime-test-fixtures.spec'

// Fork-only (Pod): session.tabs.updatePaneLayout's activeLeafId with no window.
const root = {
  type: 'split' as const,
  direction: 'vertical' as const,
  first: { type: 'leaf' as const, leafId: HEADLESS_LEAF_ID },
  second: { type: 'leaf' as const, leafId: 'leaf-2' },
  ratio: 0.7
}

function headless() {
  const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
    makeWorkspaceSessionWithHeadlessTerminal()
  )
  return { runtime: new OrcaRuntimeService(runtimeStore as never), getSession }
}

describe('updatePaneLayout activeLeafId on a headless host (Pod)', () => {
  it('keeps the active pane with the splits', async () => {
    const { runtime, getSession } = headless()
    await expect(
      runtime.updateMobileSessionPaneLayout(`id:${TEST_WORKTREE_ID}`, {
        tabId: 'host-tab',
        root,
        expandedLeafId: null,
        activeLeafId: 'leaf-2'
      })
    ).resolves.toEqual({ updated: true, appliedBy: 'headless' })
    const persisted = getSession().terminalLayoutsByTabId['host-tab']
    expect(persisted).toMatchObject({ root: { ratio: 0.7 }, activeLeafId: 'leaf-2' })
  })

  it('refuses an active pane the layout lacks and writes none of the update', async () => {
    const { runtime, getSession } = headless()
    const before = getSession().terminalLayoutsByTabId['host-tab']
    await expect(
      runtime.updateMobileSessionPaneLayout(`id:${TEST_WORKTREE_ID}`, {
        tabId: 'host-tab',
        root,
        expandedLeafId: null,
        activeLeafId: 'gone'
      })
    ).resolves.toEqual({ updated: false, reason: 'leaf_not_found' })
    expect(getSession().terminalLayoutsByTabId['host-tab']).toEqual(before)
  })

  it('refuses an active pane for a tab it has no layout for', async () => {
    const { runtime } = headless()
    await expect(
      runtime.updateMobileSessionPaneLayout(`id:${TEST_WORKTREE_ID}`, {
        tabId: 'no-such-tab',
        root: null,
        expandedLeafId: null,
        activeLeafId: HEADLESS_LEAF_ID
      })
    ).resolves.toEqual({ updated: false, reason: 'tab_not_found' })
  })
})
