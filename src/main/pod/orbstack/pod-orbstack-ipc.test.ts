import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../shared/repo-types'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

const { resolveLocalWorktreeTarget } = await import('./pod-orbstack-ipc')

function repo(overrides: Partial<Repo>): Repo {
  return {
    id: 'repo-1',
    path: '/Users/me/web',
    displayName: 'web',
    badgeColor: '#000',
    addedAt: 0,
    ...overrides
  }
}

describe('resolveLocalWorktreeTarget', () => {
  const isDir = (path: string): boolean => path.startsWith('/Users/me/')

  it('resolves a local worktree, folder workspaces included', () => {
    expect(resolveLocalWorktreeTarget('repo-1::/Users/me/web', 'web', [repo({})], isDir)).toEqual({
      worktreeId: 'repo-1::/Users/me/web',
      worktreePath: '/Users/me/web',
      displayName: 'web'
    })
    const folderId = 'repo-1::/Users/me/notes::workspace:0b6c2f3e-7c1a-4a7e-9a59-6e0d2f6c1a2b'
    expect(resolveLocalWorktreeTarget(folderId, null, [repo({})], isDir)).toMatchObject({
      worktreePath: '/Users/me/notes'
    })
  })

  it('refuses remote repos, unknown repos and missing folders', () => {
    expect(
      resolveLocalWorktreeTarget(
        'repo-1::/Users/me/web',
        null,
        [repo({ connectionId: 'ssh-1' })],
        isDir
      )
    ).toMatch(/remote/)
    expect(
      resolveLocalWorktreeTarget(
        'repo-1::/Users/me/web',
        null,
        [repo({ executionHostId: 'runtime:abc' })],
        isDir
      )
    ).toMatch(/remote/)
    expect(resolveLocalWorktreeTarget('repo-2::/Users/me/web', null, [repo({})], isDir)).toMatch(
      /Unknown/
    )
    expect(resolveLocalWorktreeTarget('repo-1::/tmp/gone', null, [repo({})], isDir)).toMatch(
      /does not exist/
    )
  })
})
