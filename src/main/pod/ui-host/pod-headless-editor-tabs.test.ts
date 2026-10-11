import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { buildHeadlessMobileSessionEditorTabs } from '../../runtime/mobile-session-editor-projection'

const mocks = vi.hoisted(() => ({ headless: { value: true } }))
vi.mock('./pod-ui-host-launch', () => ({ isPodHeadlessUiHost: () => mocks.headless.value }))

import { addHeadlessEditorTab, openPodHeadlessEditorTab } from './pod-headless-editor-tabs'

const worktreeId = 'repo::/w'
const file = { filePath: '/w/src/app.ts', relativePath: 'src/app.ts' }

function withGroup(): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabGroups: { [worktreeId]: [{ id: 'g1', worktreeId, activeTabId: 't1', tabOrder: ['t1'] }] }
  }
}

beforeEach(() => {
  mocks.headless.value = true
})

describe('addHeadlessEditorTab', () => {
  it('opens the file in the worktree group as the renderer would, and the projection lists it', () => {
    const next = addHeadlessEditorTab(withGroup(), worktreeId, file, true, 5)
    expect(next.openFilesByWorktree?.[worktreeId]).toEqual([
      { ...file, worktreeId, language: 'plaintext' }
    ])
    expect(next.unifiedTabs?.[worktreeId]).toEqual([
      expect.objectContaining({
        id: file.filePath,
        entityId: file.filePath,
        groupId: 'g1',
        contentType: 'editor',
        label: 'app.ts',
        createdAt: 5
      })
    ])
    expect(next.tabGroups?.[worktreeId]?.[0]).toMatchObject({
      tabOrder: ['t1', file.filePath],
      activeTabId: file.filePath
    })
    expect(next.activeFileIdByWorktree?.[worktreeId]).toBe(file.filePath)
    expect(buildHeadlessMobileSessionEditorTabs(worktreeId, next)).toEqual([
      expect.objectContaining({
        type: 'file',
        id: file.filePath,
        filePath: file.filePath,
        relativePath: 'src/app.ts',
        mode: 'edit',
        isDirty: false,
        isActive: true
      })
    ])
  })

  it('opens a file once, leaves the active tab to a caller-only open, and marks markdown', () => {
    const once = addHeadlessEditorTab(withGroup(), worktreeId, file, false, 1)
    const twice = addHeadlessEditorTab(once, worktreeId, file, false, 2)
    expect(twice.openFilesByWorktree?.[worktreeId]).toHaveLength(1)
    expect(twice.unifiedTabs?.[worktreeId]).toHaveLength(1)
    expect(twice.tabGroups?.[worktreeId]?.[0]).toMatchObject({ activeTabId: 't1' })
    expect(twice.activeFileIdByWorktree?.[worktreeId]).toBeUndefined()
    const notes = addHeadlessEditorTab(
      withGroup(),
      worktreeId,
      { filePath: '/w/README.md', relativePath: 'README.md' },
      false,
      1
    )
    expect(buildHeadlessMobileSessionEditorTabs(worktreeId, notes)[0]).toMatchObject({
      type: 'markdown'
    })
  })

  it('leaves the unified tab to the renderer when no window ever laid the worktree out', () => {
    const next = addHeadlessEditorTab(getDefaultWorkspaceSession(), worktreeId, file, true, 1)
    expect(next.openFilesByWorktree?.[worktreeId]).toHaveLength(1)
    expect(next.unifiedTabs?.[worktreeId]).toBeUndefined()
    expect(buildHeadlessMobileSessionEditorTabs(worktreeId, next)).toHaveLength(1)
  })
})

describe('openPodHeadlessEditorTab', () => {
  function host(session: WorkspaceSessionState | null) {
    return {
      getWorkspaceSessionForWorktree: vi.fn(() => session),
      setWorkspaceSessionForWorktree: vi.fn(),
      hydrateHeadlessMobileSessionTabsFromWorkspaceSession: vi.fn(),
      notifyMobileSessionTabsChanged: vi.fn()
    }
  }

  it('stores, republishes and lists the tab on the headless runtime', () => {
    const target = host(withGroup())
    expect(
      openPodHeadlessEditorTab(target, worktreeId, file.filePath, file.relativePath, 'caller', 3)
    ).toBe(true)
    expect(target.setWorkspaceSessionForWorktree).toHaveBeenCalledWith(
      worktreeId,
      expect.objectContaining({
        openFilesByWorktree: { [worktreeId]: [expect.objectContaining(file)] }
      })
    )
    expect(target.hydrateHeadlessMobileSessionTabsFromWorkspaceSession).toHaveBeenCalledWith(
      worktreeId,
      {
        force: true
      }
    )
    expect(target.notifyMobileSessionTabsChanged).toHaveBeenCalledWith(worktreeId)
  })

  it('leaves renderer_unavailable to every other runtime', () => {
    mocks.headless.value = false
    const target = host(withGroup())
    expect(
      openPodHeadlessEditorTab(target, worktreeId, file.filePath, file.relativePath, 'all')
    ).toBe(false)
    expect(target.setWorkspaceSessionForWorktree).not.toHaveBeenCalled()
  })
})
