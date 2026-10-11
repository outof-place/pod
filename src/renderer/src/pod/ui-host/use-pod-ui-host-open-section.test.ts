// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  store: {
    openSettingsPage: vi.fn(),
    openSettingsTarget: vi.fn(),
    openModal: vi.fn(),
    openTaskPage: vi.fn(),
    setSidebarOpen: vi.fn(),
    setSidebarBody: vi.fn(),
    showRightSidebarSearch: vi.fn(),
    setRightSidebarOpen: vi.fn(),
    setRightSidebarTab: vi.fn()
  },
  openNewWorkspace: vi.fn()
}))

vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.store } }))
vi.mock('@/hooks/ipc-events/new-workspace-command', () => ({
  openNewWorkspaceFromShortcut: mocks.openNewWorkspace
}))
vi.mock('@/components/sidebar/useWorkspaceBoardPanel', () => ({
  TOGGLE_WORKSPACE_BOARD_EVENT: 'test:toggle-workspace-board'
}))

const { openPodUiHostSection } = await import('./use-pod-ui-host-open-section')

beforeEach(() => {
  vi.clearAllMocks()
})

describe('openPodUiHostSection', () => {
  it('opens a Settings pane, and a project pane for the asked worktree', () => {
    expect(openPodUiHostSection({ surface: 'settings', section: 'terminal' })).toBe(true)
    expect(mocks.store.openSettingsPage).toHaveBeenCalled()
    expect(mocks.store.openSettingsTarget).toHaveBeenCalledWith({ pane: 'terminal', repoId: null })
    openPodUiHostSection({ surface: 'settings', section: 'repo', worktreeId: 'repo-1::/w' })
    expect(mocks.store.openSettingsTarget).toHaveBeenLastCalledWith({
      pane: 'repo',
      repoId: 'repo-1'
    })
  })

  it('leaves Settings where they are for a pane this build lacks', () => {
    expect(openPodUiHostSection({ surface: 'settings', section: 'no-such-pane' })).toBe(false)
    expect(mocks.store.openSettingsPage).not.toHaveBeenCalled()
  })

  it('opens the window views PodNative falls back to', () => {
    openPodUiHostSection({ surface: 'window', section: 'new-workspace' })
    expect(mocks.openNewWorkspace).toHaveBeenCalledWith(mocks.store)
    openPodUiHostSection({ surface: 'window', section: 'add-project' })
    expect(mocks.store.openModal).toHaveBeenCalledWith('add-repo')
    openPodUiHostSection({ surface: 'window', section: 'tasks' })
    expect(mocks.store.openTaskPage).toHaveBeenCalled()
    openPodUiHostSection({ surface: 'window', section: 'activity' })
    expect(mocks.store.setSidebarBody).toHaveBeenCalledWith('agents')
    const board = vi.fn()
    window.addEventListener('test:toggle-workspace-board', board)
    openPodUiHostSection({ surface: 'window', section: 'workspace-board' })
    expect(board).toHaveBeenCalled()
    expect(mocks.store.setSidebarOpen).toHaveBeenCalledWith(true)
  })

  it('opens the right sidebar at the asked panel', () => {
    openPodUiHostSection({ surface: 'window', section: 'source-control' })
    expect(mocks.store.setRightSidebarOpen).toHaveBeenCalledWith(true)
    expect(mocks.store.setRightSidebarTab).toHaveBeenCalledWith('source-control')
    openPodUiHostSection({ surface: 'window', section: 'search' })
    expect(mocks.store.showRightSidebarSearch).toHaveBeenCalled()
  })

  it('ignores a window section this build lacks', () => {
    expect(openPodUiHostSection({ surface: 'window', section: 'later' })).toBe(false)
    expect(mocks.store.setRightSidebarTab).not.toHaveBeenCalled()
  })
})
