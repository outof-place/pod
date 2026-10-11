import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeClientEvent } from '../../../shared/runtime-client-events'
import type * as ServicesModule from './pod-headless-window-services'

const mocks = vi.hoisted(() => ({
  headless: { value: true },
  setContext: vi.fn(),
  schedule: vi.fn(),
  scheduleCurrent: vi.fn(),
  folderWatch: vi.fn(),
  historyGc: vi.fn(),
  openCodeGc: vi.fn(),
  openCode2Gc: vi.fn(),
  liveIds: vi.fn(),
  knownIds: vi.fn(() => new Set(['wt-1']))
}))

vi.mock('../../ipc/worktree-base-directory-watcher', () => ({
  setWorktreeBaseDirectoryWatcherSyncContext: mocks.setContext,
  scheduleWorktreeBaseDirectoryWatcherSync: mocks.schedule,
  scheduleCurrentWorktreeBaseDirectoryWatcherSync: mocks.scheduleCurrent
}))
vi.mock('../../ipc/folder-repo-git-upgrade', () => ({
  startFolderRepoGitUpgradeWatch: mocks.folderWatch
}))
vi.mock('../../terminal-history-gc', () => ({ scheduleHistoryGc: mocks.historyGc }))
vi.mock('../../window/history-gc-worktree-ids', () => ({
  getKnownWorktreeIdsForHistoryGc: mocks.knownIds
}))
vi.mock('../../opencode/hook-service', () => ({
  openCodeHookService: { configDirGc: { schedule: mocks.openCodeGc } },
  openCode2HookService: { configDirGc: { schedule: mocks.openCode2Gc } }
}))
vi.mock('../../daemon/daemon-provider-state', () => ({ listLiveDaemonPtyIds: mocks.liveIds }))
vi.mock('./pod-ui-host-launch', () => ({ isPodHeadlessUiHost: () => mocks.headless.value }))

type Module = typeof ServicesModule

function makeRuntime() {
  const listeners: ((event: RuntimeClientEvent) => void)[] = []
  return {
    listeners,
    notifyWorktreeCatalogChangedForRemoteClients: vi.fn(),
    notifyReposChangedForRemoteClients: vi.fn(),
    onClientEvent: vi.fn((listener: (event: RuntimeClientEvent) => void) => {
      listeners.push(listener)
      return () => {}
    })
  }
}

const store = { getRepos: () => [], getSettings: () => ({}) }

async function load(): Promise<Module> {
  vi.resetModules()
  return import('./pod-headless-window-services')
}

beforeEach(() => {
  mocks.headless.value = true
  vi.clearAllMocks()
})

describe('installPodHeadlessWindowServices', () => {
  it('does nothing outside the headless runtime', async () => {
    mocks.headless.value = false
    const { installPodHeadlessWindowServices, rearmPodHeadlessWindowServices } = await load()
    const runtime = makeRuntime()
    installPodHeadlessWindowServices(store as never, runtime)
    rearmPodHeadlessWindowServices()
    expect(mocks.setContext).not.toHaveBeenCalled()
    expect(mocks.folderWatch).not.toHaveBeenCalled()
    expect(mocks.historyGc).not.toHaveBeenCalled()
    expect(mocks.openCodeGc).not.toHaveBeenCalled()
    expect(runtime.onClientEvent).not.toHaveBeenCalled()
  })

  it('arms the watchers with a windowless target, once', async () => {
    const { installPodHeadlessWindowServices } = await load()
    const runtime = makeRuntime()
    installPodHeadlessWindowServices(store as never, runtime)
    installPodHeadlessWindowServices(store as never, runtime)
    expect(mocks.setContext).toHaveBeenCalledOnce()
    const [contextStore, target] = mocks.setContext.mock.calls[0]
    expect(contextStore).toBe(store)
    expect(target.isDestroyed()).toBe(false)
    expect(mocks.schedule).toHaveBeenCalledWith(store, target)
    expect(mocks.folderWatch).toHaveBeenCalledWith(store, target)
    expect(runtime.onClientEvent).toHaveBeenCalledOnce()
  })

  it('schedules the terminal history and OpenCode overlay collections', async () => {
    const { installPodHeadlessWindowServices } = await load()
    installPodHeadlessWindowServices(store as never, makeRuntime())
    expect(mocks.historyGc).toHaveBeenCalledOnce()
    // The history GC keeps what the store knows, read when it runs.
    expect(await mocks.historyGc.mock.calls[0][0]()).toEqual(new Set(['wt-1']))
    expect(mocks.knownIds).toHaveBeenCalledWith(store)
    expect(mocks.openCodeGc).toHaveBeenCalledWith(mocks.liveIds)
    expect(mocks.openCode2Gc).toHaveBeenCalledWith(mocks.liveIds)
  })

  it('resyncs when repos change over the runtime, and on nothing else', async () => {
    const { installPodHeadlessWindowServices } = await load()
    const runtime = makeRuntime()
    installPodHeadlessWindowServices(store as never, runtime)
    runtime.listeners[0]({ type: 'worktreesChanged', repoId: 'r' })
    expect(mocks.scheduleCurrent).not.toHaveBeenCalled()
    runtime.listeners[0]({ type: 'reposChanged' })
    expect(mocks.scheduleCurrent).toHaveBeenCalledOnce()
  })

  it('gives the watches back to the same target after a window closes', async () => {
    const { installPodHeadlessWindowServices, rearmPodHeadlessWindowServices } = await load()
    installPodHeadlessWindowServices(store as never, makeRuntime())
    const target = mocks.setContext.mock.calls[0][1]
    rearmPodHeadlessWindowServices()
    expect(mocks.setContext).toHaveBeenLastCalledWith(store, target)
    expect(mocks.schedule).toHaveBeenLastCalledWith(store, target)
    expect(mocks.folderWatch).toHaveBeenLastCalledWith(store, target)
  })
})

describe('the windowless target', () => {
  it('carries watched changes to remote clients', async () => {
    vi.resetModules()
    vi.doUnmock('../../ipc/worktree-base-directory-watcher')
    const { createPodWindowlessTarget } = await import('./pod-headless-window-services')
    const { notifyWatchedWorktreeCatalogChanged, setWorktreeCatalogRemoteClientNotifier } =
      await import('../../ipc/watched-worktree-catalog-notification')
    const { notifyReposChanged, setRepoRemoteClientNotifier } =
      await import('../../ipc/repos/repos-changed-notification')
    const { notifyWorktreeGitStatusMetadataChanged, notifyWorktreeHeadIdentitiesChanged } =
      await import('../../ipc/worktree-remote')
    const runtime = makeRuntime()
    setWorktreeCatalogRemoteClientNotifier(runtime)
    setRepoRemoteClientNotifier(runtime)
    const target = createPodWindowlessTarget()
    notifyWatchedWorktreeCatalogChanged(target, 'repo-1')
    notifyWorktreeGitStatusMetadataChanged(target, 'repo-1')
    notifyWorktreeHeadIdentitiesChanged(target, 'repo-1', [])
    // What the folder upgrade sends once `git init` lands.
    notifyReposChanged(target)
    expect(runtime.notifyWorktreeCatalogChangedForRemoteClients).toHaveBeenCalledWith('repo-1')
    expect(runtime.notifyReposChangedForRemoteClients).toHaveBeenCalledOnce()
    setWorktreeCatalogRemoteClientNotifier(null)
  })
})
