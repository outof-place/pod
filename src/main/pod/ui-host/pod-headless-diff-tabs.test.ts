import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'

const mocks = vi.hoisted(() => ({ headless: { value: true } }))

vi.mock('./pod-ui-host-launch', () => ({ isPodHeadlessUiHost: () => mocks.headless.value }))

import {
  deactivatePodHeadlessDiffTabs,
  headlessDiffTabId,
  listPodHeadlessDiffTabs,
  openPodHeadlessDiffTab,
  removePodHeadlessDiffTab
} from './pod-headless-diff-tabs'
import {
  buildHeadlessMobileSessionEditorTabs,
  retireHeadlessMobileSessionEditorTab
} from '../../runtime/mobile-session-editor-projection'

let sequence = 0

function session(worktreeId: string): WorkspaceSessionState {
  return {
    openFilesByWorktree: {
      [worktreeId]: [
        { filePath: '/repo/a.ts', relativePath: 'a.ts', worktreeId, language: 'typescript' }
      ]
    },
    activeFileIdByWorktree: { [worktreeId]: '/repo/a.ts' },
    activeTabTypeByWorktree: { [worktreeId]: 'editor' }
  } as unknown as WorkspaceSessionState
}

function makeHost(worktreeId: string) {
  let current: WorkspaceSessionState | null = session(worktreeId)
  return {
    getWorkspaceSessionForWorktree: vi.fn(() => current),
    setWorkspaceSessionForWorktree: vi.fn((_id: string, next: WorkspaceSessionState) => {
      current = next
    }),
    hydrateHeadlessMobileSessionTabsFromWorkspaceSession: vi.fn(),
    notifyMobileSessionTabsChanged: vi.fn(),
    mobileSessionTabsByWorktree: new Map(),
    storeMobileSessionSnapshot: vi.fn(),
    clearSession: () => {
      current = null
    }
  }
}

function worktree(): string {
  sequence += 1
  return `repo::/w${sequence}`
}

beforeEach(() => {
  mocks.headless.value = true
})

describe('openPodHeadlessDiffTab', () => {
  it('lists staged and unstaged diffs apart, as Pod names them, and publishes', () => {
    const id = worktree()
    const host = makeHost(id)
    expect(openPodHeadlessDiffTab(host, id, '/repo/a.ts', 'a.ts', false, 'all')).toBe(true)
    expect(openPodHeadlessDiffTab(host, id, '/repo/a.ts', 'a.ts', true, 'all')).toBe(true)
    expect(listPodHeadlessDiffTabs(id)).toEqual([
      expect.objectContaining({
        type: 'file',
        id: `${id}::diff::unstaged::a.ts`,
        mode: 'diff',
        diffSource: 'unstaged',
        filePath: '/repo/a.ts',
        relativePath: 'a.ts',
        title: 'a.ts',
        isDirty: false,
        isActive: false
      }),
      expect.objectContaining({ id: headlessDiffTabId(id, 'a.ts', true), isActive: true })
    ])
    expect(host.hydrateHeadlessMobileSessionTabsFromWorkspaceSession).toHaveBeenCalledWith(id, {
      force: true
    })
    expect(host.notifyMobileSessionTabsChanged).toHaveBeenCalledWith(id)
  })

  it('leaves the active tab alone for the caller, and reopening adds nothing', () => {
    const id = worktree()
    const host = makeHost(id)
    openPodHeadlessDiffTab(host, id, '/repo/a.ts', 'a.ts', false, 'caller')
    openPodHeadlessDiffTab(host, id, '/repo/a.ts', 'a.ts', false, 'caller')
    expect(listPodHeadlessDiffTabs(id)).toEqual([expect.objectContaining({ isActive: false })])
    openPodHeadlessDiffTab(host, id, '/repo/a.ts', 'a.ts', false, 'host')
    expect(listPodHeadlessDiffTabs(id)).toEqual([expect.objectContaining({ isActive: true })])
    deactivatePodHeadlessDiffTabs(id)
    expect(listPodHeadlessDiffTabs(id)).toEqual([expect.objectContaining({ isActive: false })])
  })

  it('leaves renderer_unavailable outside the headless runtime or without a session', () => {
    const id = worktree()
    const host = makeHost(id)
    mocks.headless.value = false
    expect(openPodHeadlessDiffTab(host, id, '/repo/a.ts', 'a.ts', false, 'all')).toBe(false)
    mocks.headless.value = true
    host.clearSession()
    expect(openPodHeadlessDiffTab(host, id, '/repo/a.ts', 'a.ts', false, 'all')).toBe(false)
    expect(listPodHeadlessDiffTabs(id)).toEqual([])
  })
})

describe('the headless projection', () => {
  it('lists diffs after the files and retires one without touching the file tab', () => {
    const id = worktree()
    const host = makeHost(id)
    openPodHeadlessDiffTab(host, id, '/repo/a.ts', 'a.ts', false, 'all')
    const listed = buildHeadlessMobileSessionEditorTabs(id, session(id))
    expect(listed.map((tab) => tab.id)).toEqual(['/repo/a.ts', `${id}::diff::unstaged::a.ts`])
    const diff = listed[1]
    expect(
      retireHeadlessMobileSessionEditorTab(host, id, {
        id: diff.id,
        type: diff.type,
        filePath: diff.filePath
      })
    ).toBe(true)
    expect(listPodHeadlessDiffTabs(id)).toEqual([])
    // The session still has the file, and was written back unchanged.
    expect(host.setWorkspaceSessionForWorktree).toHaveBeenCalledWith(
      id,
      expect.objectContaining({
        openFilesByWorktree: { [id]: [expect.objectContaining({ filePath: '/repo/a.ts' })] }
      })
    )
    expect(removePodHeadlessDiffTab(id, diff.id)).toBe(false)
  })
})
