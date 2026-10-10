import { afterEach, describe, expect, it, vi } from 'vitest'
import { eraseRpcMethods, isStreamingMethod, type RpcContext } from '../../runtime/rpc/core'
import { POD_WORKSPACE_METHODS } from './pod-workspace-rpc-methods'
import { setPodWorkspaceRpcService, type PodWorkspaceRpcService } from './workspace-rpc-service'

const removeManagedWorktree = vi.fn(async () => ({}))
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: handlers only read runtime.removeManagedWorktree.
const ctx = { runtime: { removeManagedWorktree } } as unknown as RpcContext

function call(name: string, params?: unknown): unknown {
  const entry = eraseRpcMethods(POD_WORKSPACE_METHODS).find((candidate) => candidate.name === name)
  if (!entry || isStreamingMethod(entry)) {
    throw new Error(`missing ${name}`)
  }
  return entry.handler(entry.params ? entry.params.parse(params) : undefined, ctx)
}

function fakeService(enabled: boolean): PodWorkspaceRpcService {
  return {
    isEnabled: () => enabled,
    status: vi.fn(),
    tidyScan: vi.fn(async () => ({
      scannedAt: 1,
      worktrees: [],
      strayFolders: [],
      prunable: [],
      archives: [],
      errors: []
    })),
    tidyApply: vi.fn(async (_action, remove) => {
      await remove('repo-1::/w')
      return { ok: true, message: 'Archived w' }
    }),
    gitProfile: vi.fn(async () => ({ profile: null })),
    cloneDestination: vi.fn(async () => '/Users/me/pod/acme'),
    adopt: vi.fn()
  }
}

afterEach(() => {
  setPodWorkspaceRpcService(null)
  removeManagedWorktree.mockClear()
})

describe('podWorkspace.* RPC methods', () => {
  it('needs host-admin only to move folders', () => {
    expect(
      Object.fromEntries(POD_WORKSPACE_METHODS.map((entry) => [entry.name, entry.permission]))
    ).toEqual({
      'podWorkspace.enabled': 'workspace',
      'podWorkspace.status': 'workspace',
      'podWorkspace.tidyScan': 'workspace',
      'podWorkspace.tidyApply': 'workspace',
      'podWorkspace.gitProfile': 'workspace',
      'podWorkspace.cloneDestination': 'workspace',
      'podWorkspace.adopt': 'host-admin'
    })
  })

  it('answers enabled false and refuses the rest when the feature is off', async () => {
    expect(call('podWorkspace.enabled')).toEqual({ enabled: false })
    setPodWorkspaceRpcService(fakeService(false))
    expect(() => call('podWorkspace.tidyScan', {})).toThrow(/off in this build/)
  })

  it('archives through the runtime removal, unforced', async () => {
    setPodWorkspaceRpcService(fakeService(true))
    await call('podWorkspace.tidyApply', { action: { kind: 'archive', worktreeId: 'repo-1::/w' } })
    expect(removeManagedWorktree).toHaveBeenCalledWith('id:repo-1::/w', {
      waitForBackgroundRemoval: true
    })
  })

  it('rejects unknown actions at the schema', () => {
    setPodWorkspaceRpcService(fakeService(true))
    expect(() =>
      call('podWorkspace.tidyApply', { action: { kind: 'delete-everything' } })
    ).toThrow()
    expect(() => call('podWorkspace.gitProfile', { repoId: 'r', action: 'force' })).toThrow()
  })

  it('wraps the clone destination', async () => {
    setPodWorkspaceRpcService(fakeService(true))
    await expect(
      call('podWorkspace.cloneDestination', { url: 'git@github.com:acme/x.git' })
    ).resolves.toEqual({
      destination: '/Users/me/pod/acme'
    })
  })
})
