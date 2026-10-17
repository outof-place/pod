import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeSliceGet } from '../listing/worktree-slice-types'

const ensureHooksConfirmed = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]): Promise<'run' | 'skip'> => 'run')
)
vi.mock('@/lib/ensure-hooks-confirmed', () => ({ ensureHooksConfirmed }))

const { skipRemovalArchive } = await import('./removal-archive-trust')

function getWith(rows: { id: string; foreignOrigin?: boolean }[]): WorktreeSliceGet {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the helper reads only allWorktrees().
  return (() => ({ allWorktrees: () => rows })) as unknown as WorktreeSliceGet
}

describe('the archive question before a removal (Pod)', () => {
  beforeEach(() => ensureHooksConfirmed.mockClear())

  it('asks every time for a checkout of someone else’s code', async () => {
    const id = 'repo-1::/w/pr-7'
    expect(
      await skipRemovalArchive(getWith([{ id, foreignOrigin: true }]), id, undefined, null)
    ).toBe(false)
    expect(ensureHooksConfirmed.mock.lastCall?.[6]).toMatchObject({ foreign: true })
  })

  it('keeps the usual question, and its skip, for the repo’s own', async () => {
    const id = 'repo-1::/w/feature'
    ensureHooksConfirmed.mockResolvedValueOnce('skip')
    expect(await skipRemovalArchive(getWith([{ id }]), id, undefined, null)).toBe(true)
    expect(ensureHooksConfirmed.mock.lastCall?.[6]).toBeUndefined()
  })
})
