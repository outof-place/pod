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

function fakeService(enabled: boolean) {
  return {
    isEnabled: () => enabled,
    status: vi.fn(),
    validateRoot: vi.fn(),
    excludeBuildFolders: vi.fn(async () => ({
      excluded: 2,
      failed: [],
      destination: 'none' as const
    })),
    openSpotlightSettings: vi.fn(async () => true),
    cloneDestination: vi.fn(async () => '/Users/me/pod/acme'),
    tidyScan: vi.fn(),
    tidyApply: vi.fn(async (_request, remove) => {
      await remove('repo-1::/w')
      return { ok: true, message: 'Archived w' }
    }),
    gitProfile: vi.fn(async () => ({ ok: true, message: 'Tuned 3 settings' })),
    adopt: vi.fn()
  } satisfies PodWorkspaceRpcService
}

afterEach(() => {
  setPodWorkspaceRpcService(null)
  removeManagedWorktree.mockClear()
})

describe('podWorkspace.* RPC methods', () => {
  it('needs host-admin for every method', () => {
    expect(new Set(POD_WORKSPACE_METHODS.map((entry) => entry.permission))).toEqual(
      new Set(['host-admin'])
    )
    expect(POD_WORKSPACE_METHODS.map((entry) => entry.name)).toEqual([
      'podWorkspace.enabled',
      'podWorkspace.status',
      'podWorkspace.validateRoot',
      'podWorkspace.excludeBuildFolders',
      'podWorkspace.openSpotlightSettings',
      'podWorkspace.cloneDestination',
      'podWorkspace.tidyScan',
      'podWorkspace.tidyApply',
      'podWorkspace.gitProfile',
      'podWorkspace.adopt'
    ])
  })

  it('answers enabled false and refuses the rest when the feature is off', async () => {
    expect(call('podWorkspace.enabled')).toEqual({ enabled: false })
    setPodWorkspaceRpcService(fakeService(false))
    expect(() => call('podWorkspace.tidyScan', {})).toThrow(/off in this build/)
  })

  it('archives through the runtime removal, with the plan and ticks it was given', async () => {
    const service = fakeService(true)
    setPodWorkspaceRpcService(service)
    const action = { kind: 'archive', worktreeId: 'repo-1::/w' }
    await call('podWorkspace.tidyApply', {
      planId: 'p1',
      reason: 'user',
      acknowledged: ['dirty'],
      action
    })
    expect(service.tidyApply).toHaveBeenCalledWith(
      { planId: 'p1', action, acknowledged: ['dirty'] },
      expect.any(Function)
    )
    expect(removeManagedWorktree).toHaveBeenCalledWith('id:repo-1::/w', {
      waitForBackgroundRemoval: true
    })
  })

  it('refuses a change without a plan id or without the user intent', () => {
    setPodWorkspaceRpcService(fakeService(true))
    const action = { kind: 'prune', repoId: 'repo-1' }
    expect(() => call('podWorkspace.tidyApply', { reason: 'user', action })).toThrow()
    expect(() => call('podWorkspace.tidyApply', { planId: 'p1', action })).toThrow()
    expect(() =>
      call('podWorkspace.tidyApply', { planId: 'p1', reason: 'agent', action })
    ).toThrow()
    expect(() =>
      call('podWorkspace.gitProfile', { action: 'apply', planId: 'p1', optIns: ['reftable'] })
    ).toThrow()
    expect(() => call('podWorkspace.adopt', { action: 'apply', planId: 'p1' })).toThrow()
    expect(() => call('podWorkspace.excludeBuildFolders', { planId: 'p1' })).toThrow()
    expect(() => call('podWorkspace.openSpotlightSettings', {})).toThrow()
  })

  it('rejects unknown actions and ticks at the schema', () => {
    setPodWorkspaceRpcService(fakeService(true))
    expect(() =>
      call('podWorkspace.tidyApply', {
        planId: 'p1',
        reason: 'user',
        action: { kind: 'delete-everything' }
      })
    ).toThrow()
    expect(() =>
      call('podWorkspace.tidyApply', {
        planId: 'p1',
        reason: 'user',
        acknowledged: ['main-worktree'],
        action: { kind: 'prune', repoId: 'repo-1' }
      })
    ).toThrow()
    expect(() => call('podWorkspace.gitProfile', { repoId: 'r', action: 'force' })).toThrow()
  })

  it('passes a profile apply through with its plan and opt-ins', async () => {
    const service = fakeService(true)
    setPodWorkspaceRpcService(service)
    const request = { action: 'apply', planId: 'p1', reason: 'user', optIns: ['backfill'] }
    await call('podWorkspace.gitProfile', request)
    expect(service.gitProfile).toHaveBeenCalledWith(request)
  })

  it('wraps the clone destination and the Spotlight pane', async () => {
    setPodWorkspaceRpcService(fakeService(true))
    await expect(
      call('podWorkspace.cloneDestination', { url: 'git@github.com:acme/x.git' })
    ).resolves.toEqual({ destination: '/Users/me/pod/acme' })
    await expect(call('podWorkspace.openSpotlightSettings', { reason: 'user' })).resolves.toEqual({
      opened: true
    })
  })
})
