// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import type * as WorktreeOperationRoute from './worktree-operation-route'

const { resolveRouteMock } = vi.hoisted(() => ({ resolveRouteMock: vi.fn() }))
vi.mock('./worktree-operation-route', async (importOriginal) => ({
  ...(await importOriginal<typeof WorktreeOperationRoute>()),
  resolveWorktreeOperationRoute: resolveRouteMock
}))

import { noteLocalFileOpened } from './local-file-open-activity'

// The route is mocked, so any store state will do.
const state = useAppStore.getState()
function file(filePath: string, overrides: Partial<OpenFile> = {}): OpenFile {
  return {
    id: filePath,
    filePath,
    relativePath: filePath.slice('/repo/'.length),
    worktreeId: 'wt-1',
    language: 'typescript',
    isDirty: false,
    mode: 'edit',
    ...overrides
  }
}

describe('noteLocalFileOpened', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    resolveRouteMock.mockReset()
  })

  it('tells the host index about a local file once per activation', () => {
    const noteFileOpened = vi.fn(async () => undefined)
    vi.stubGlobal('api', { fs: { noteFileOpened } })
    resolveRouteMock.mockReturnValue({ executionHostId: 'local', runtimeEnvironmentId: null })
    noteLocalFileOpened(state, file('/repo/src/a.ts'))
    noteLocalFileOpened(state, file('/repo/src/a.ts'))
    noteLocalFileOpened(state, file('/repo/src/b.ts'))
    expect(noteFileOpened.mock.calls).toEqual([
      [{ filePath: '/repo/src/a.ts' }],
      [{ filePath: '/repo/src/b.ts' }]
    ])
  })

  it('skips remote files, diffs and untitled drafts', () => {
    const noteFileOpened = vi.fn(async () => undefined)
    vi.stubGlobal('api', { fs: { noteFileOpened } })
    resolveRouteMock.mockReturnValue({ executionHostId: 'ssh:box', runtimeEnvironmentId: null })
    noteLocalFileOpened(state, file('/repo/src/remote.ts'))
    resolveRouteMock.mockReturnValue({ executionHostId: 'local', runtimeEnvironmentId: 'env-1' })
    noteLocalFileOpened(state, file('/repo/src/paired.ts'))
    resolveRouteMock.mockReturnValue({ executionHostId: 'local', runtimeEnvironmentId: null })
    noteLocalFileOpened(state, file('/repo/src/diff.ts', { mode: 'diff' }))
    noteLocalFileOpened(state, file('/repo/src/new.md', { isUntitled: true }))
    expect(noteFileOpened).not.toHaveBeenCalled()
  })
})
