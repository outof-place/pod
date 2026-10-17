import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeSliceGet } from '../listing/worktree-slice-types'
import type { ensureHooksConfirmed as ensureHooksConfirmedType } from '@/lib/ensure-hooks-confirmed'

type EnsureHooksConfirmed = typeof ensureHooksConfirmedType

const ensureHooksConfirmed = vi.hoisted(() =>
  vi.fn(async (..._args: Parameters<EnsureHooksConfirmed>): Promise<'run' | 'skip'> => 'run')
)
vi.mock('@/lib/ensure-hooks-confirmed', () => ({ ensureHooksConfirmed }))

const { confirmRemovalArchive } = await import('./removal-archive-trust')

function getWith(
  rows: { id: string; foreignOrigin?: boolean; linkedPR?: number }[]
): WorktreeSliceGet {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the helper reads only allWorktrees().
  return (() => ({ allWorktrees: () => rows })) as unknown as WorktreeSliceGet
}

describe('the archive question before a removal (Pod)', () => {
  beforeEach(() => ensureHooksConfirmed.mockClear())

  it('asks every time for a checkout of someone else’s code, and sends the approved hash', async () => {
    const id = 'repo-1::/w/pr-7'
    ensureHooksConfirmed.mockImplementationOnce(async (...args) => {
      args[6]?.onTrusted('e'.repeat(64))
      return 'run'
    })
    expect(
      await confirmRemovalArchive(getWith([{ id, foreignOrigin: true }]), id, undefined, null)
    ).toEqual({ skip: false, archiveTrustHash: 'e'.repeat(64) })
    expect(ensureHooksConfirmed.mock.lastCall?.[6]).toMatchObject({ foreign: true })
    // Made before Pod kept the mark: a linked pull request says the same.
    await confirmRemovalArchive(getWith([{ id, linkedPR: 7 }]), id, undefined, null)
    expect(ensureHooksConfirmed.mock.lastCall?.[6]).toMatchObject({ foreign: true })
  })

  it('keeps the usual question, and its skip, for the repo’s own', async () => {
    const id = 'repo-1::/w/feature'
    ensureHooksConfirmed.mockResolvedValueOnce('skip')
    expect(await confirmRemovalArchive(getWith([{ id }]), id, undefined, null)).toEqual({
      skip: true
    })
    expect(ensureHooksConfirmed.mock.lastCall?.[6]).toBeUndefined()
  })
})
