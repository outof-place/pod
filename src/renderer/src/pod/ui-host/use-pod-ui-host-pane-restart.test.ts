import { describe, expect, it, vi } from 'vitest'

const mount = vi.hoisted(() => vi.fn())
vi.mock('@/components/terminal/background-terminal-worktree-mount', () => ({
  requestBackgroundTerminalWorktreeMount: mount
}))

const { registerPodPaneRestarter, restartPodPane } = await import('./use-pod-ui-host-pane-restart')

describe('restartPodPane (Pod)', () => {
  it('lets a mounted tab restart its own leaf', () => {
    const restarter = vi.fn(() => true)
    const unregister = registerPodPaneRestarter('tab-a', restarter)
    expect(restartPodPane({ worktreeId: 'wt', tabId: 'tab-a', leafId: 'left' })).toBe(true)
    expect(restarter).toHaveBeenCalledWith('left')
    expect(mount).not.toHaveBeenCalled()
    unregister()
  })

  it('mounts a tab this window has no pane for, which starts its shell', () => {
    expect(restartPodPane({ worktreeId: 'wt', tabId: 'tab-b', leafId: 'left' })).toBe(true)
    expect(mount).toHaveBeenCalledWith({ worktreeId: 'wt', tabIds: ['tab-b'] })
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
