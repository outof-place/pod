import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../shared/runtime-types'
import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode
} from '../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import {
  applyPodHeadlessActiveLeaf,
  applyPodPaneLayoutInWindow,
  refusePodHeadlessActiveLeaf,
  setPodRendererPaneLayoutApply,
  type PodPaneLayoutHost
} from './pod-pane-layout-sync'

afterEach(() => setPodRendererPaneLayoutApply(null))

const root: TerminalPaneLayoutNode = {
  type: 'split',
  direction: 'vertical',
  first: { type: 'leaf', leafId: 'left' },
  second: { type: 'leaf', leafId: 'right' },
  ratio: 0.3
}
const layout: TerminalLayoutSnapshot = { root, activeLeafId: 'left', expandedLeafId: null }

function leaf(leafId: string, isActive: boolean) {
  return {
    type: 'terminal' as const,
    id: `tab::${leafId}`,
    parentTabId: 'tab',
    leafId,
    title: leafId,
    isActive,
    parentLayout: layout
  }
}

function host(tabActive = true) {
  let session: WorkspaceSessionState = {
    activeRepoId: null,
    activeWorktreeId: 'wt',
    activeTabId: 'tab',
    tabsByWorktree: {},
    terminalLayoutsByTabId: { tab: layout }
  }
  const snapshots = new Map<string, RuntimeMobileSessionTabsSnapshot>([
    [
      'wt',
      {
        worktree: 'wt',
        publicationEpoch: 'headless:1',
        snapshotVersion: 3,
        activeGroupId: null,
        activeTabId: null,
        activeTabType: null,
        tabs: [leaf('left', tabActive), leaf('right', false)]
      }
    ]
  ])
  const emitted: RuntimeMobileSessionTabsSnapshot[] = []
  const fake: PodPaneLayoutHost = {
    getAvailableAuthoritativeWindow: () => null,
    mobileSessionTabsByWorktree: snapshots,
    resolveMobileSessionHostTabId: (_snapshot, tabId) => tabId.split('::')[0] ?? null,
    getWorkspaceSessionForWorktree: () => session,
    setWorkspaceSessionForWorktree: (_worktreeId, next) => {
      session = next
    },
    storeMobileSessionSnapshot: (worktreeId, snapshot) => snapshots.set(worktreeId, snapshot),
    emitMobileSessionTabsSnapshot: (snapshot) => emitted.push(snapshot)
  }
  return { fake, emitted, session: () => session, snapshot: () => snapshots.get('wt') }
}

describe('applyPodPaneLayoutInWindow (Pod)', () => {
  const args = { tabId: 'tab::right', root, expandedLeafId: null, activeLeafId: 'right' }

  it("hands the layout to the window's renderer under the host tab id", async () => {
    const apply = vi.fn(async () => ({ applied: true as const }))
    setPodRendererPaneLayoutApply(apply)
    const { fake } = host()
    const window = { id: 1 }
    fake.getAvailableAuthoritativeWindow = () => window

    await expect(applyPodPaneLayoutInWindow(fake, 'wt', args)).resolves.toEqual({
      updated: true,
      appliedBy: 'renderer'
    })
    expect(apply).toHaveBeenCalledWith(window, {
      worktreeId: 'wt',
      tabId: 'tab',
      root,
      expandedLeafId: null,
      activeLeafId: 'right'
    })
  })

  it("answers with the renderer's refusal, its silence, or its absence", async () => {
    const { fake } = host()
    fake.getAvailableAuthoritativeWindow = () => ({})
    await expect(applyPodPaneLayoutInWindow(fake, 'wt', args)).resolves.toEqual({
      updated: false,
      reason: 'renderer_unavailable'
    })
    setPodRendererPaneLayoutApply(async () => ({ applied: false, reason: 'layout_mismatch' }))
    await expect(applyPodPaneLayoutInWindow(fake, 'wt', args)).resolves.toEqual({
      updated: false,
      reason: 'layout_mismatch'
    })
    setPodRendererPaneLayoutApply(async () => null)
    await expect(applyPodPaneLayoutInWindow(fake, 'wt', args)).resolves.toEqual({
      updated: false,
      reason: 'renderer_timeout'
    })
  })
})

describe('applyPodHeadlessActiveLeaf (Pod)', () => {
  it("keeps the active pane on the tab's layout and moves the snapshot's active pane", () => {
    const { fake, emitted, session, snapshot } = host()

    expect(applyPodHeadlessActiveLeaf(fake, 'wt', 'tab', layout, 'right')).toEqual({
      updated: true,
      appliedBy: 'headless'
    })

    expect(session().terminalLayoutsByTabId.tab?.activeLeafId).toBe('right')
    const tabs = snapshot()?.tabs ?? []
    expect(tabs.map((tab) => [tab.id, tab.isActive])).toEqual([
      ['tab::left', false],
      ['tab::right', true]
    ])
    expect(
      tabs.every((tab) => tab.type === 'terminal' && tab.parentLayout?.activeLeafId === 'right')
    ).toBe(true)
    expect(snapshot()?.snapshotVersion).toBe(4)
    expect(emitted).toHaveLength(1)
  })

  it('never makes a tab that is not active the active one', () => {
    const { fake, snapshot } = host(false)
    applyPodHeadlessActiveLeaf(fake, 'wt', 'tab', layout, 'right')
    expect(snapshot()?.tabs.some((tab) => tab.isActive)).toBe(false)
  })

  it('refuses a leaf the layout lacks and writes nothing without an active pane', () => {
    const { fake, emitted, session } = host()
    expect(applyPodHeadlessActiveLeaf(fake, 'wt', 'tab', layout, 'gone')).toEqual({
      updated: false,
      reason: 'leaf_not_found'
    })
    expect(applyPodHeadlessActiveLeaf(fake, 'wt', 'tab', layout, undefined)).toEqual({
      updated: true,
      appliedBy: 'headless'
    })
    expect(session().terminalLayoutsByTabId.tab?.activeLeafId).toBe('left')
    expect(emitted).toHaveLength(0)
  })
})

describe('refusePodHeadlessActiveLeaf (Pod)', () => {
  it("checks the active pane against the client's splits, else the stored ones", () => {
    const { fake } = host()
    expect(
      refusePodHeadlessActiveLeaf(fake, 'wt', 'tab', { root: null, activeLeafId: 'right' })
    ).toBeNull()
    expect(
      refusePodHeadlessActiveLeaf(fake, 'wt', 'tab', {
        root: { type: 'leaf', leafId: 'left' },
        activeLeafId: 'right'
      })
    ).toEqual({ updated: false, reason: 'leaf_not_found' })
    expect(refusePodHeadlessActiveLeaf(fake, 'wt', 'tab', { root: null })).toBeNull()
  })

  it('refuses an active pane for a tab without a stored layout', () => {
    const { fake } = host()
    expect(
      refusePodHeadlessActiveLeaf(fake, 'wt', 'other', { root: null, activeLeafId: 'left' })
    ).toEqual({ updated: false, reason: 'tab_not_found' })
    expect(applyPodHeadlessActiveLeaf(fake, 'wt', 'other', undefined, 'left')).toEqual({
      updated: false,
      reason: 'tab_not_found'
    })
  })
})
