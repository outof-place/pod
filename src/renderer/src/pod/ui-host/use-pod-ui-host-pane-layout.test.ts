import { describe, expect, it, vi } from 'vitest'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'

const store = vi.hoisted(() => {
  const terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot> = {}
  return { terminalLayoutsByTabId, setTabLayout: vi.fn() }
})
vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))

const { applyPodPaneLayout, registerPodPaneLayoutApplier } =
  await import('./use-pod-ui-host-pane-layout')

const request = { worktreeId: 'wt', tabId: 'tab-a', root: null, expandedLeafId: null }

describe('applyPodPaneLayout (Pod)', () => {
  it('lets a mounted tab apply the layout to its own panes', () => {
    const applier = vi.fn(() => ({ applied: true as const }))
    const unregister = registerPodPaneLayoutApplier('tab-a', applier)
    expect(applyPodPaneLayout(request)).toEqual({ applied: true })
    expect(applier).toHaveBeenCalledWith(request)
    expect(store.setTabLayout).not.toHaveBeenCalled()
    unregister()
  })

  it('writes the stored layout of a tab this window has not mounted', () => {
    store.terminalLayoutsByTabId['tab-b'] = {
      root: { type: 'leaf', leafId: 'left' },
      activeLeafId: 'left',
      expandedLeafId: null
    }
    expect(applyPodPaneLayout({ ...request, tabId: 'tab-b', activeLeafId: 'left' })).toEqual({
      applied: true
    })
    expect(store.setTabLayout).toHaveBeenCalledWith('tab-b', {
      root: { type: 'leaf', leafId: 'left' },
      activeLeafId: 'left',
      expandedLeafId: null
    })
    expect(applyPodPaneLayout({ ...request, tabId: 'tab-none' })).toEqual({
      applied: false,
      reason: 'tab_not_found'
    })
  })

  it("keeps a remount's applier when the old mount unregisters", () => {
    const first = vi.fn(() => ({ applied: true as const }))
    const second = vi.fn(() => ({ applied: false as const, reason: 'layout_mismatch' as const }))
    const unregisterFirst = registerPodPaneLayoutApplier('tab-c', first)
    registerPodPaneLayoutApplier('tab-c', second)
    unregisterFirst()
    expect(applyPodPaneLayout({ ...request, tabId: 'tab-c' })).toEqual({
      applied: false,
      reason: 'layout_mismatch'
    })
    expect(first).not.toHaveBeenCalled()
  })
})
