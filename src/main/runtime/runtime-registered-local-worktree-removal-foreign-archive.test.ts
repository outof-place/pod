import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const runHook = vi.hoisted(() => vi.fn(async () => ({ success: true, output: '' })))
const registrationRead = vi.hoisted(() => new Error('stop after the archive step'))
vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))
vi.mock('../hooks', () => ({
  runHook,
  getEffectiveHooks: () => ({ scripts: { archive: 'make clean' } })
}))
vi.mock('../git/worktree', () => ({
  assertWorktreeCleanForRemoval: vi.fn(),
  listWorktreesStrict: vi.fn(async () => {
    throw registrationRead
  }),
  removeWorktree: vi.fn()
}))
vi.mock('../ipc/worktree-remote', () => ({ cleanupUnusedWorktreePushTargetRemote: vi.fn() }))

const { removeRuntimeRegisteredLocalWorktree } =
  await import('./runtime-registered-local-worktree-removal')
const { withApprovedArchive } = await import('./foreign-removal-archive')

const stopPtys = vi.fn(async () => {})
const removal = (meta: { foreignOrigin?: boolean }) =>
  removeRuntimeRegisteredLocalWorktree(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the archive step reads only these; the registration read below stops the removal.
    {
      repo: { id: 'repo-1', path: '/repo', displayName: 'repo', badgeColor: 'blue', addedAt: 1 },
      target: { id: 'repo-1::/w/pr-7', repoId: 'repo-1', path: '/w/pr-7' },
      registeredWorktree: { path: '/w/pr-7' },
      store: { getWorktreeMeta: () => meta },
      localOptions: {},
      hasLocalOptions: false,
      force: true,
      runHooks: true,
      allowFailedArchiveHook: false,
      allowUnverifiedPtyStop: false,
      deleteBranch: true,
      stopPtys
    } as never
  )

describe('a runtime removal’s archive step in someone else’s checkout (Pod)', () => {
  beforeEach(() => {
    runHook.mockClear()
    stopPtys.mockClear()
  })

  it('refuses before anything runs without this removal’s hash', async () => {
    await expect(removal({ foreignOrigin: true })).rejects.toThrow(
      'needs approval for this removal'
    )
    expect(runHook).not.toHaveBeenCalled()
    expect(stopPtys).not.toHaveBeenCalled()
  })

  it('runs the archive script with it, and the repo’s own worktree’s as before', async () => {
    const hash = createHash('sha256').update('make clean').digest('hex')
    await expect(withApprovedArchive(hash, () => removal({ foreignOrigin: true }))).rejects.toBe(
      registrationRead
    )
    expect(runHook).toHaveBeenCalledOnce()
    await expect(removal({})).rejects.toBe(registrationRead)
    expect(runHook).toHaveBeenCalledTimes(2)
  })
})
