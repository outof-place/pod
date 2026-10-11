import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeClientEvent } from '../../../shared/runtime-client-events'
import type * as WatchModule from './pod-headless-worktree-watch'

const mocks = vi.hoisted(() => ({
  headless: { value: true },
  setContext: vi.fn(),
  schedule: vi.fn(),
  scheduleCurrent: vi.fn()
}))

vi.mock('../../ipc/worktree-base-directory-watcher', () => ({
  setWorktreeBaseDirectoryWatcherSyncContext: mocks.setContext,
  scheduleWorktreeBaseDirectoryWatcherSync: mocks.schedule,
  scheduleCurrentWorktreeBaseDirectoryWatcherSync: mocks.scheduleCurrent
}))
vi.mock('./pod-ui-host-launch', () => ({ isPodHeadlessUiHost: () => mocks.headless.value }))

type Module = typeof WatchModule

function makeRuntime() {
  const listeners: ((event: RuntimeClientEvent) => void)[] = []
  return {
    listeners,
    notifyWorktreeCatalogChangedForRemoteClients: vi.fn(),
    onClientEvent: vi.fn((listener: (event: RuntimeClientEvent) => void) => {
      listeners.push(listener)
      return () => {}
    })
  }
}

const store = { getRepos: () => [], getSettings: () => ({}) }

async function load(): Promise<Module> {
  vi.resetModules()
  return import('./pod-headless-worktree-watch')
}

beforeEach(() => {
  mocks.headless.value = true
  vi.clearAllMocks()
})

describe('installPodHeadlessWorktreeWatch', () => {
  it('does nothing outside the headless runtime', async () => {
    mocks.headless.value = false
    const { installPodHeadlessWorktreeWatch, rearmPodHeadlessWorktreeWatch } = await load()
    const runtime = makeRuntime()
    installPodHeadlessWorktreeWatch(store as never, runtime)
    rearmPodHeadlessWorktreeWatch()
    expect(mocks.setContext).not.toHaveBeenCalled()
    expect(mocks.schedule).not.toHaveBeenCalled()
    expect(runtime.onClientEvent).not.toHaveBeenCalled()
  })

  it('arms the watcher with a windowless target, once', async () => {
    const { installPodHeadlessWorktreeWatch } = await load()
    const runtime = makeRuntime()
    installPodHeadlessWorktreeWatch(store as never, runtime)
    installPodHeadlessWorktreeWatch(store as never, runtime)
    expect(mocks.setContext).toHaveBeenCalledOnce()
    const [contextStore, target] = mocks.setContext.mock.calls[0]
    expect(contextStore).toBe(store)
    expect(target.isDestroyed()).toBe(false)
    expect(mocks.schedule).toHaveBeenCalledWith(store, target)
    expect(runtime.onClientEvent).toHaveBeenCalledOnce()
  })

  it('resyncs when repos change over the runtime, and on nothing else', async () => {
    const { installPodHeadlessWorktreeWatch } = await load()
    const runtime = makeRuntime()
    installPodHeadlessWorktreeWatch(store as never, runtime)
    runtime.listeners[0]({ type: 'worktreesChanged', repoId: 'r' })
    expect(mocks.scheduleCurrent).not.toHaveBeenCalled()
    runtime.listeners[0]({ type: 'reposChanged' })
    expect(mocks.scheduleCurrent).toHaveBeenCalledOnce()
  })

  it('gives the watches back to the same target after a window closes', async () => {
    const { installPodHeadlessWorktreeWatch, rearmPodHeadlessWorktreeWatch } = await load()
    installPodHeadlessWorktreeWatch(store as never, makeRuntime())
    const target = mocks.setContext.mock.calls[0][1]
    rearmPodHeadlessWorktreeWatch()
    expect(mocks.setContext).toHaveBeenLastCalledWith(store, target)
    expect(mocks.schedule).toHaveBeenLastCalledWith(store, target)
  })
})

describe('the windowless target', () => {
  it('carries a watched catalog change to remote clients', async () => {
    vi.resetModules()
    vi.doUnmock('../../ipc/worktree-base-directory-watcher')
    const { createPodWindowlessWatchTarget } = await import('./pod-headless-worktree-watch')
    const { notifyWatchedWorktreeCatalogChanged, setWorktreeCatalogRemoteClientNotifier } =
      await import('../../ipc/watched-worktree-catalog-notification')
    const { notifyWorktreeGitStatusMetadataChanged, notifyWorktreeHeadIdentitiesChanged } =
      await import('../../ipc/worktree-remote')
    const runtime = makeRuntime()
    setWorktreeCatalogRemoteClientNotifier(runtime)
    const target = createPodWindowlessWatchTarget()
    notifyWatchedWorktreeCatalogChanged(target, 'repo-1')
    notifyWorktreeGitStatusMetadataChanged(target, 'repo-1')
    notifyWorktreeHeadIdentitiesChanged(target, 'repo-1', [])
    expect(runtime.notifyWorktreeCatalogChangedForRemoteClients).toHaveBeenCalledWith('repo-1')
    setWorktreeCatalogRemoteClientNotifier(null)
  })
})
