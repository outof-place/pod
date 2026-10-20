// Fork-only (Pod): worktree.forgetLocal's forget on the desktop's own worktree IPC harness: the
// same body as worktrees:forgetLocal, the window's removal registry, and nothing on the host.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  listWorktreesMock,
  removeWorktreeMock,
  getSshGitProviderMock,
  getSshFilesystemProviderMock,
  deleteWorktreeHistoryDirMock,
  killAllProcessesForWorktreeMock,
  clearProviderPtyStateMock,
  getLocalPtyProviderMock,
  getSshPtyProviderMock
} from './worktrees-test-module-mocks'
import { handlers, mainWindow, setupWorktreeHandlers, store } from './worktrees-test-harness'
import type { WorktreeRuntimeStub } from './worktrees-test-runtime-stub'
import { getWorktreeRemovalInFlightKey } from './worktrees/removal/worktree-removal-coordinator'
import { deleteRemoteWorktreeHistory } from '../remote-worktree-history-cleanup'
import { installPodWorktreeForgetLocal } from '../pod/worktrees/pod-worktree-forget-local-rpc'
import { getPodWorktreeForgetLocal } from '../pod/worktrees/pod-worktree-forget-local-installed'
import { getPodWorktreeRemovalRegistry } from '../pod/worktrees/pod-worktree-removal-registry'
import type { Store } from '../persistence/loading-store/store'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'

vi.mock('electron', async () =>
  (await import('./worktrees-test-module-mocks')).electronModuleMock()
)
vi.mock('../git/worktree', async () =>
  (await import('./worktrees-test-module-mocks')).gitWorktreeModuleMock()
)
vi.mock('../git/runner', async () =>
  (await import('./worktrees-test-module-mocks')).gitRunnerModuleMock()
)
vi.mock('../git/repo', async () =>
  (await import('./worktrees-test-module-mocks')).gitRepoModuleMock()
)
vi.mock('../git/git-username', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveLocalGitUsername: (await import('./worktrees-test-module-mocks'))
    .resolveLocalGitUsernameMock
}))
vi.mock('../github/client', async () =>
  (await import('./worktrees-test-module-mocks')).githubClientModuleMock()
)
vi.mock('../source-control/hosted-review', async () =>
  (await import('./worktrees-test-module-mocks')).hostedReviewModuleMock()
)
vi.mock('../providers/ssh-git-dispatch', async () =>
  (await import('./worktrees-test-module-mocks')).sshGitDispatchModuleMock()
)
vi.mock('../providers/ssh-filesystem-dispatch', async () =>
  (await import('./worktrees-test-module-mocks')).sshFilesystemDispatchModuleMock()
)
vi.mock('./worktree-symlinks', async () =>
  (await import('./worktrees-test-module-mocks')).worktreeSymlinksModuleMock()
)
vi.mock('./ssh', async () => (await import('./worktrees-test-module-mocks')).sshModuleMock())
vi.mock('../ssh/ssh-target-registry', async () =>
  (await import('./worktrees-test-module-mocks')).sshTargetRegistryModuleMock()
)
vi.mock('../hooks', async () => (await import('./worktrees-test-module-mocks')).hooksModuleMock())
vi.mock('../setup-runner-script-text', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).setupRunnerScriptTextModuleMock(
    await importOriginal<Record<string, unknown>>()
  )
)
vi.mock('../worktree-runner-script', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).worktreeRunnerScriptModuleMock(
    await importOriginal<Record<string, unknown>>()
  )
)
vi.mock('../effective-hook-config', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).effectiveHookConfigModuleMock(
    await importOriginal<Record<string, unknown>>()
  )
)
vi.mock('../setup-hook-env-vars', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).setupHookEnvVarsModuleMock(
    await importOriginal<Record<string, unknown>>()
  )
)
vi.mock('./worktree-logic', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).worktreeLogicModuleMock(
    await importOriginal<Record<string, unknown>>()
  )
)
vi.mock('../terminal-history-deletion', async () =>
  (await import('./worktrees-test-module-mocks')).terminalHistoryDeletionModuleMock()
)
vi.mock('../ports/advertised-url-watcher', async () =>
  (await import('./worktrees-test-module-mocks')).advertisedUrlWatcherModuleMock()
)
vi.mock('../workspace-cleanup-scan-snapshot', async () =>
  (await import('./worktrees-test-module-mocks')).workspaceCleanupScanSnapshotModuleMock()
)
vi.mock('../workspace-space-analysis-snapshot', async () =>
  (await import('./worktrees-test-module-mocks')).workspaceSpaceAnalysisSnapshotModuleMock()
)
vi.mock('../workspace-cleanup-removal-snapshot-prune', async () =>
  (await import('./worktrees-test-module-mocks')).workspaceCleanupRemovalSnapshotPruneModuleMock()
)
vi.mock('../runtime/worktree-teardown', async () =>
  (await import('./worktrees-test-module-mocks')).worktreeTeardownModuleMock()
)
vi.mock('./pty', async () => (await import('./worktrees-test-module-mocks')).ptyModuleMock())

// Never the real one: it deletes the workspace's history on the host. Only its absence is checked.
vi.mock('../remote-worktree-history-cleanup', () => ({ deleteRemoteWorktreeHistory: vi.fn() }))

const sshRepo = {
  id: 'repo-ssh',
  path: '/workspace/repo',
  displayName: 'repo',
  badgeColor: '#000',
  addedAt: 0,
  connectionId: 'ssh-gone',
  worktreeBaseRef: null
}
const worktreeId = 'repo-ssh::/workspace/feature-wt'
const hostId = 'ssh:ssh-gone'
const localProvider = { kind: 'local-provider' }
const connectedSshProvider = { kind: 'ssh-provider' }

function worktreesChangedSends(): unknown[][] {
  return mainWindow.webContents.send.mock.calls.filter(
    ([channel]) => channel === 'worktrees:changed'
  )
}

describe('worktree.forgetLocal through the desktop forget', () => {
  let runtimeStub: WorktreeRuntimeStub
  const removeManagedWorktree = vi.fn()

  beforeEach(() => {
    runtimeStub = setupWorktreeHandlers()
    removeManagedWorktree.mockClear()
    vi.mocked(deleteRemoteWorktreeHistory).mockClear()
    store.getRepos.mockReturnValue([sshRepo])
    store.getRepo.mockReturnValue(sshRepo)
    store.getWorktreeMeta.mockReturnValue({ hostId })
    getSshPtyProviderMock.mockReturnValue(undefined)
    getLocalPtyProviderMock.mockReturnValue(localProvider)
    installPodWorktreeForgetLocal(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the harness store stubs every Store method the forget and its host check call.
      store as unknown as Store,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub holds every runtime method the forget calls, plus worktree.rm's, to prove it is never called.
      Object.assign(runtimeStub, { removeManagedWorktree }) as unknown as OrcaRuntimeService
    )
  })

  function forget(): Promise<void> {
    const installed = getPodWorktreeForgetLocal()
    if (!installed) {
      throw new Error('worktree.forgetLocal is not installed')
    }
    return installed({ worktreeId, hostId })
  }

  /** The MUST: no Git, no provider file system, no history on the host, never worktree.rm. */
  function expectHostUntouched(): void {
    expect(getSshGitProviderMock).not.toHaveBeenCalled()
    expect(getSshFilesystemProviderMock).not.toHaveBeenCalled()
    expect(listWorktreesMock).not.toHaveBeenCalled()
    expect(removeWorktreeMock).not.toHaveBeenCalled()
    expect(deleteRemoteWorktreeHistory).not.toHaveBeenCalled()
    expect(removeManagedWorktree).not.toHaveBeenCalled()
  }

  it("forgets an offline SSH workspace's partition and tells every client once, with nothing on the host", async () => {
    await expect(forget()).resolves.toBeUndefined()

    expect(killAllProcessesForWorktreeMock).toHaveBeenCalledWith(worktreeId, {
      runtime: runtimeStub,
      resolvedWorktreeId: worktreeId,
      resolvedConnectionId: 'ssh-gone',
      localProvider,
      onPtyStopped: clearProviderPtyStateMock,
      closeStructuredSessions: true,
      includeProviderInventory: false,
      includeLocalRegistry: false
    })
    expect(store.removeWorktreeMeta).toHaveBeenCalledExactlyOnceWith(worktreeId, hostId)
    // Pod's own terminal history on this machine, in its profile.
    expect(deleteWorktreeHistoryDirMock).toHaveBeenCalledWith(worktreeId)
    expect(runtimeStub.publishWorktreeRemovalChange).toHaveBeenCalledExactlyOnceWith('repo-ssh')
    expect(runtimeStub.notifyWorktreesChangedForRemoteClients).not.toHaveBeenCalled()
    expect(worktreesChangedSends()).toEqual([['worktrees:changed', { repoId: 'repo-ssh' }]])
    expectHostUntouched()
  })

  it("refuses while the host's provider is connected, before anything changes", async () => {
    getSshPtyProviderMock.mockReturnValue(connectedSshProvider)

    await expect(forget()).rejects.toMatchObject({
      code: 'worktree_forget_refused',
      data: { reason: 'host_connected' }
    })

    expect(killAllProcessesForWorktreeMock).not.toHaveBeenCalled()
    expect(runtimeStub.clearOptimisticReconcileToken).not.toHaveBeenCalled()
    expect(store.removeWorktreeMeta).not.toHaveBeenCalled()
    expect(deleteWorktreeHistoryDirMock).not.toHaveBeenCalled()
    expect(runtimeStub.publishWorktreeRemovalChange).not.toHaveBeenCalled()
    expect(worktreesChangedSends()).toEqual([])
    expect(getPodWorktreeRemovalRegistry().size).toBe(0)
    expectHostUntouched()
  })

  it('lets the next forget and a removal go ahead after a refusal', async () => {
    getSshPtyProviderMock.mockReturnValue(connectedSshProvider)
    await expect(forget()).rejects.toMatchObject({ data: { reason: 'host_connected' } })
    // A removal refuses only while the workspace's key is in the registry; the refusal left none.
    expect(
      getPodWorktreeRemovalRegistry().has(getWorktreeRemovalInFlightKey(worktreeId, hostId))
    ).toBe(false)

    getSshPtyProviderMock.mockReturnValue(undefined)
    await expect(forget()).resolves.toBeUndefined()
    expect(store.removeWorktreeMeta).toHaveBeenCalledExactlyOnceWith(worktreeId, hostId)
    expect(getPodWorktreeRemovalRegistry().size).toBe(0)
    expectHostUntouched()
  })

  it('joins a forget the window already runs, so the workspace is purged once', async () => {
    let release = (): void => {}
    killAllProcessesForWorktreeMock.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        release = resolve
      })
    )
    const fromWindow = handlers['worktrees:forgetLocal'](null, { worktreeId, hostId })
    const fromRpc = forget()
    release()

    await expect(Promise.all([fromWindow, fromRpc])).resolves.toEqual([{}, undefined])
    expect(killAllProcessesForWorktreeMock).toHaveBeenCalledTimes(1)
    expect(store.removeWorktreeMeta).toHaveBeenCalledExactlyOnceWith(worktreeId, hostId)
    expectHostUntouched()
  })

  it('refuses while the window removes the same workspace, in the one registry both use', async () => {
    const registry = getPodWorktreeRemovalRegistry()
    const key = getWorktreeRemovalInFlightKey(worktreeId, hostId)
    registry.set(key, { optionsKey: 'remove', promise: new Promise(() => {}) })
    try {
      const refusal = `Worktree deletion already in progress: ${worktreeId}`
      // The window's own forget sees the entry too, so this is the registry its removals use.
      await expect(handlers['worktrees:forgetLocal'](null, { worktreeId, hostId })).rejects.toThrow(
        refusal
      )
      await expect(forget()).rejects.toThrow(refusal)
    } finally {
      registry.delete(key)
    }
    expect(killAllProcessesForWorktreeMock).not.toHaveBeenCalled()
    expect(store.removeWorktreeMeta).not.toHaveBeenCalled()
  })

  it("makes the window's own forget tell RPC clients too, once", async () => {
    await expect(handlers['worktrees:forgetLocal'](null, { worktreeId, hostId })).resolves.toEqual(
      {}
    )

    expect(runtimeStub.notifyWorktreesChangedForRemoteClients).toHaveBeenCalledExactlyOnceWith(
      'repo-ssh'
    )
    expect(worktreesChangedSends()).toEqual([['worktrees:changed', { repoId: 'repo-ssh' }]])
    expect(runtimeStub.publishWorktreeRemovalChange).not.toHaveBeenCalled()
  })
})
