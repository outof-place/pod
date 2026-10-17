import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { runSerializedWorktreeRemovalAcceptance } from '../worktree-removal-acceptance-queue'
import { assertForeignArchiveApproved, withApprovedArchive } from './foreign-removal-archive'

const hash = createHash('sha256').update('make clean').digest('hex')
const check = (meta: { foreignOrigin?: boolean; linkedPR?: number } | undefined) => () =>
  assertForeignArchiveApproved(meta, ' make clean ', '/w/pr-7')

describe('an archive run in someone else’s checkout (Pod)', () => {
  it('refuses without this removal’s hash, and runs with it', async () => {
    expect(check({ foreignOrigin: true })).toThrow('needs approval for this removal')
    // Made before Pod kept the mark: a linked pull request says the same.
    await withApprovedArchive('f'.repeat(64), async () =>
      expect(check({ linkedPR: 7 })).toThrow('needs approval for this removal')
    )
    await withApprovedArchive(hash, async () =>
      expect(check({ foreignOrigin: true })).not.toThrow()
    )
  })

  it('leaves the repo’s own worktrees alone', () => {
    expect(check({})).not.toThrow()
    expect(check(undefined)).not.toThrow()
  })

  it('keeps each removal’s hash through the queue that serializes a repo’s removals', async () => {
    const gate = Promise.withResolvers<void>()
    const first = withApprovedArchive(hash, () =>
      runSerializedWorktreeRemovalAcceptance('/repo', async () => {
        await gate.promise
        check({ foreignOrigin: true })()
      })
    )
    // Queued behind the approved one, with no approval of its own.
    const second = withApprovedArchive(undefined, () =>
      runSerializedWorktreeRemovalAcceptance('/repo', async () => check({ foreignOrigin: true })())
    )
    gate.resolve()
    await expect(first).resolves.toBeUndefined()
    await expect(second).rejects.toThrow('needs approval for this removal')
  })
})
