import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'

const getArchiveHooksForRemoval = vi.hoisted(() =>
  vi.fn(async () => ({ scripts: { archive: 'make clean' } }))
)
vi.mock('../ipc/worktrees/removal/worktree-archive-hook', () => ({ getArchiveHooksForRemoval }))

const { assertForeignArchiveApproved } = await import('./foreign-removal-archive')

const repo: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'repo',
  badgeColor: 'blue',
  addedAt: 1
}
const runtimeWith = (worktree: { foreignOrigin?: boolean; linkedPR?: number } | null) => ({
  showManagedWorktree: async () => {
    if (!worktree) {
      throw new Error('selector_not_found')
    }
    return { repoId: 'repo-1', path: '/w/pr-7', ...worktree }
  },
  listRepos: () => [repo]
})

describe('worktree.rm --run-hooks on someone else’s code (Pod)', () => {
  it('refuses without this removal’s hash, and runs with it', async () => {
    const hash = createHash('sha256').update('make clean').digest('hex')
    await expect(
      assertForeignArchiveApproved(runtimeWith({ foreignOrigin: true }), 'id:x', undefined)
    ).rejects.toThrow('needs approval for this removal')
    // Made before Pod kept the mark: a linked pull request says the same.
    await expect(
      assertForeignArchiveApproved(runtimeWith({ linkedPR: 7 }), 'id:x', 'f'.repeat(64))
    ).rejects.toThrow('needs approval for this removal')
    await expect(
      assertForeignArchiveApproved(runtimeWith({ foreignOrigin: true }), 'id:x', hash)
    ).resolves.toBeUndefined()
  })

  it('leaves the repo’s own worktrees, and ones Git no longer lists, to the removal', async () => {
    await expect(
      assertForeignArchiveApproved(runtimeWith({}), 'id:x', undefined)
    ).resolves.toBeUndefined()
    await expect(
      assertForeignArchiveApproved(runtimeWith(null), 'id:x', undefined)
    ).resolves.toBeUndefined()
  })
})
