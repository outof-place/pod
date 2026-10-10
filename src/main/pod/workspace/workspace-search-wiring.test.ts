import { afterEach, describe, expect, it, vi } from 'vitest'

const search = vi.hoisted(() => ({
  notify: vi.fn(),
  status: vi.fn(async () => null)
}))

vi.mock('../../search/external-workspace-search-provider', () => ({
  notifyExternalSearchWorktreeLifecycle: search.notify
}))
vi.mock('../search/install-pod-native-search', () => ({
  getPodSearchIndexStatus: search.status
}))

import {
  getWorkspaceIndexStatusProvider,
  primeWorkspaceRoots,
  resetWorkspaceRootEventsForTests,
  syncWorkspaceRoots
} from './workspace-root-events'
import {
  toSearchWorktreeLifecycleEvents,
  wireWorkspaceToPodSearch
} from './workspace-search-wiring'

afterEach(() => {
  resetWorkspaceRootEventsForTests()
  search.notify.mockClear()
})

describe('toSearchWorktreeLifecycleEvents', () => {
  it('registers added roots and forgets removed ones', () => {
    expect(toSearchWorktreeLifecycleEvents({ kind: 'added', repoId: 'a', path: '/p/a' })).toEqual([
      { kind: 'created', path: '/p/a' }
    ])
    expect(toSearchWorktreeLifecycleEvents({ kind: 'removed', repoId: 'a', path: '/p/a' })).toEqual(
      [{ kind: 'removed', path: '/p/a' }]
    )
  })

  it('forgets the old root before registering the new one on a move', () => {
    expect(
      toSearchWorktreeLifecycleEvents({
        kind: 'moved',
        repoId: 'a',
        path: '/p/acme/a',
        previousPath: '/old/a'
      })
    ).toEqual([
      { kind: 'removed', path: '/old/a' },
      { kind: 'created', path: '/p/acme/a' }
    ])
  })
})

describe('wireWorkspaceToPodSearch', () => {
  it('serves index status only while Pod search is enabled', () => {
    let enabled = false
    const unwire = wireWorkspaceToPodSearch(() => enabled)
    expect(getWorkspaceIndexStatusProvider()).toBeNull()
    enabled = true
    expect(getWorkspaceIndexStatusProvider()).toBe(search.status)
    unwire()
  })

  it('forwards root changes to the search provider and serves index status from it', () => {
    const unwire = wireWorkspaceToPodSearch(() => true)
    expect(getWorkspaceIndexStatusProvider()).toBe(search.status)

    primeWorkspaceRoots(new Map([['a', '/old/a']]))
    syncWorkspaceRoots(
      new Map([
        ['a', '/p/acme/a'],
        ['b', '/p/acme/b']
      ])
    )
    expect(search.notify.mock.calls.map(([event]) => event)).toEqual([
      { kind: 'removed', path: '/old/a' },
      { kind: 'created', path: '/p/acme/a' },
      { kind: 'created', path: '/p/acme/b' }
    ])

    unwire()
    expect(getWorkspaceIndexStatusProvider()).toBeNull()
    syncWorkspaceRoots(new Map())
    expect(search.notify).toHaveBeenCalledTimes(3)
  })
})
