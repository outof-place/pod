import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../shared/repo-types'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import { InvalidArgumentError } from '../../runtime/rpc/core'
import { resolveForgetHost } from './pod-worktree-forget-local-rpc'

const worktreeId = 'repo-1::/workspace/feature'
const hostId = 'ssh:gone'

function repoOn(connectionId: string | null): Repo {
  return {
    id: 'repo-1',
    path: '/workspace/repo',
    displayName: 'repo',
    badgeColor: '#000',
    addedAt: 0,
    ...(connectionId ? { connectionId } : {})
  }
}

const EMPTY_META: WorktreeMeta = {
  displayName: 'feature',
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 0
}

/** Reads only: the store has no writer, so a check that tried to change it would throw. */
function storeWith(repos: Repo[], meta?: Partial<WorktreeMeta>) {
  return {
    getRepos: () => repos,
    getRepo: (id: string) => repos.find((repo) => repo.id === id),
    getWorktreeMeta: (id: string): WorktreeMeta | undefined =>
      meta && id === worktreeId ? { ...EMPTY_META, ...meta } : undefined
  }
}

function refusalOf(run: () => unknown): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  throw new Error('expected a refusal')
}

describe("worktree.forgetLocal's host check", () => {
  it('accepts the SSH host whose project Pod registers there', () => {
    expect(resolveForgetHost(storeWith([repoOn('gone')]), { worktreeId, hostId })).toBe(hostId)
    // The repo alone records ownership once the meta row is gone.
    expect(resolveForgetHost(storeWith([repoOn('gone')], {}), { worktreeId, hostId })).toBe(hostId)
  })

  it('accepts an orphan whose project is gone when its row names that host', () => {
    expect(resolveForgetHost(storeWith([], { hostId }), { worktreeId, hostId })).toBe(hostId)
  })

  it('refuses a local or runtime host: only an SSH workspace is forgotten over RPC', () => {
    for (const other of ['local', 'runtime:env-1']) {
      expect(
        refusalOf(() => resolveForgetHost(storeWith([repoOn(null)]), { worktreeId, hostId: other }))
      ).toMatchObject({ code: 'worktree_forget_refused', data: { reason: 'unsupported_host' } })
    }
  })

  it('refuses a host that is not the one Pod has for the workspace', () => {
    const cases = [
      // The row names another host.
      storeWith([repoOn('gone')], { hostId: 'ssh:live' }),
      // The project is registered on another host only.
      storeWith([repoOn('live')]),
      storeWith([repoOn(null)]),
      // An orphan whose row names another host, or none (a local row).
      storeWith([], { hostId: 'ssh:live' }),
      storeWith([], {})
    ]
    for (const store of cases) {
      expect(refusalOf(() => resolveForgetHost(store, { worktreeId, hostId }))).toMatchObject({
        code: 'worktree_forget_refused',
        data: { reason: 'host_mismatch' }
      })
    }
  })

  it('refuses when two registrations of the project on that host make the owner ambiguous', () => {
    const store = storeWith([repoOn('gone'), { ...repoOn('gone'), path: '/workspace/other' }])
    expect(refusalOf(() => resolveForgetHost(store, { worktreeId, hostId }))).toMatchObject({
      code: 'worktree_forget_refused',
      data: { reason: 'ambiguous_host' }
    })
  })

  it('refuses a workspace Pod has neither a row nor a project for', () => {
    expect(refusalOf(() => resolveForgetHost(storeWith([]), { worktreeId, hostId }))).toMatchObject(
      { code: 'worktree_forget_refused', data: { reason: 'unknown_worktree' } }
    )
  })

  it('refuses an id that names no project and path as invalid', () => {
    for (const id of ['repo-1', '::/workspace/feature', 'repo-1::']) {
      expect(
        refusalOf(() => resolveForgetHost(storeWith([repoOn('gone')]), { worktreeId: id, hostId }))
      ).toBeInstanceOf(InvalidArgumentError)
    }
  })
})
