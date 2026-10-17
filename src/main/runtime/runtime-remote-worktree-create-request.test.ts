/** Pod: the SSH create a runtime forwards keeps the client's approved orca.yaml setup hash. */

import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import type { RuntimeStore } from './runtime-store-contract'

const createRemoteWorktree = vi.hoisted(() =>
  vi.fn(async (_args: Record<string, unknown>, ..._rest: unknown[]) => ({
    worktree: { id: 'wt-remote', path: '/remote/wt' }
  }))
)

vi.mock('../ipc/worktree-remote', () => ({ createRemoteWorktree }))

const { requestRuntimeRemoteWorktree } = await import('./runtime-remote-worktree-create-request')

const repo: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'repo',
  badgeColor: 'blue',
  addedAt: 1,
  connectionId: 'conn-1'
}
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked create never reads the store.
const store = {} as unknown as RuntimeStore

describe('requestRuntimeRemoteWorktree', () => {
  it('forwards the approved setup hash', async () => {
    const setupTrustHash = 'a'.repeat(64)
    await requestRuntimeRemoteWorktree(
      repo,
      { name: 'task', setupDecision: 'run', setupTrustHash },
      store
    )
    expect(createRemoteWorktree).toHaveBeenLastCalledWith(
      expect.objectContaining({ setupDecision: 'run', setupTrustHash }),
      repo,
      store,
      expect.anything(),
      undefined
    )
  })

  it('sends no hash when the client approved none', async () => {
    await requestRuntimeRemoteWorktree(repo, { name: 'task', setupDecision: 'run' }, store)
    expect(createRemoteWorktree.mock.lastCall?.[0]).not.toHaveProperty('setupTrustHash')
  })
})
