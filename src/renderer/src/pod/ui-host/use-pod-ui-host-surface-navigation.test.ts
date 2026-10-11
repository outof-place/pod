// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { applyPodUiHostSurfaceNavigation } from './use-pod-ui-host-surface-navigation'

function store() {
  return {
    setSettingsSearchQuery: vi.fn(),
    openSettingsTarget: vi.fn(),
    openSettingsPage: vi.fn(),
    openActivityPage: vi.fn(),
    openAutomationsPage: vi.fn(),
    setSelectedAutomationId: vi.fn(),
    openSkillsPage: vi.fn(),
    openArtifactsPage: vi.fn(),
    openSpacePage: vi.fn(),
    activeModal: 'none' as const,
    activeView: 'terminal' as const,
    taskPageData: {},
    openModal: vi.fn(),
    openTaskPage: vi.fn(),
    setSidebarOpen: vi.fn(),
    showRightSidebarSearch: vi.fn(),
    setRightSidebarOpen: vi.fn(),
    setRightSidebarTab: vi.fn()
  }
}

describe('applyPodUiHostSurfaceNavigation', () => {
  it("opens a repo's settings at the anchor PodNative named", () => {
    const app = store()
    applyPodUiHostSurfaceNavigation(
      { surface: 'settings', section: 'repo', repoId: 'repo-1', item: 'repo-1-local-commands' },
      app
    )
    expect(app.setSettingsSearchQuery).toHaveBeenCalledWith('')
    expect(app.openSettingsTarget).toHaveBeenCalledWith({
      pane: 'repo',
      repoId: 'repo-1',
      sectionId: 'repo-1-local-commands'
    })
    expect(app.openSettingsPage).toHaveBeenCalledOnce()
  })

  it('opens a pane with its intent, and the settings root for a pane it does not know', () => {
    const app = store()
    applyPodUiHostSurfaceNavigation(
      { surface: 'settings', section: 'quick-commands', intent: 'add-quick-command' },
      app
    )
    expect(app.openSettingsTarget).toHaveBeenCalledWith({
      pane: 'quick-commands',
      repoId: null,
      intent: 'add-quick-command'
    })

    const older = store()
    applyPodUiHostSurfaceNavigation({ surface: 'settings', section: 'not-a-pane' }, older)
    expect(older.openSettingsTarget).not.toHaveBeenCalled()
    expect(older.openSettingsPage).toHaveBeenCalledOnce()
  })

  it('opens a top-level view and selects the item in it', () => {
    const app = store()
    applyPodUiHostSurfaceNavigation(
      { surface: 'window', section: 'automations', item: 'auto-1' },
      app
    )
    expect(app.setSelectedAutomationId).toHaveBeenCalledWith('auto-1')
    expect(app.openAutomationsPage).toHaveBeenCalledOnce()

    applyPodUiHostSurfaceNavigation({ surface: 'window', section: 'activity' }, app)
    expect(app.openActivityPage).toHaveBeenCalledOnce()
    applyPodUiHostSurfaceNavigation({ surface: 'window', section: 'unknown' }, app)
    expect(app.openSettingsPage).not.toHaveBeenCalled()
    expect(app.setRightSidebarTab).not.toHaveBeenCalled()
  })

  it('opens the right sidebar at the panel named, and search in it', () => {
    const app = store()
    applyPodUiHostSurfaceNavigation({ surface: 'window', section: 'source-control' }, app)
    expect(app.setRightSidebarOpen).toHaveBeenCalledWith(true)
    expect(app.setRightSidebarTab).toHaveBeenCalledWith('source-control')
    applyPodUiHostSurfaceNavigation({ surface: 'window', section: 'ports' }, app)
    expect(app.setRightSidebarTab).toHaveBeenLastCalledWith('ports')
    applyPodUiHostSurfaceNavigation({ surface: 'window', section: 'search' }, app)
    expect(app.showRightSidebarSearch).toHaveBeenCalledOnce()
  })

  it("opens Pod's composer, Add Project, the board, the quick commands and tasks", () => {
    const app = store()
    applyPodUiHostSurfaceNavigation({ surface: 'window', section: 'new-workspace' }, app)
    expect(app.openModal).toHaveBeenCalledWith('new-workspace-composer', {
      telemetrySource: 'shortcut'
    })
    applyPodUiHostSurfaceNavigation({ surface: 'window', section: 'add-project' }, app)
    expect(app.openModal).toHaveBeenLastCalledWith('add-repo')
    const board = vi.fn()
    const quickCommands = vi.fn()
    window.addEventListener('orca:toggle-workspace-board', board)
    window.addEventListener('orca:toggleQuickCommandsMenu', quickCommands)
    applyPodUiHostSurfaceNavigation({ surface: 'window', section: 'workspace-board' }, app)
    expect(app.setSidebarOpen).toHaveBeenCalledWith(true)
    expect(board).toHaveBeenCalledOnce()
    applyPodUiHostSurfaceNavigation({ surface: 'window', section: 'quick-commands' }, app)
    expect(quickCommands).toHaveBeenCalledOnce()
    applyPodUiHostSurfaceNavigation({ surface: 'window', section: 'tasks' }, app)
    expect(app.openTaskPage).toHaveBeenCalledOnce()
  })
})
