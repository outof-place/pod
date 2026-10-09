import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../shared/repo-types'
import {
  computeWorkspaceRoots,
  getWorkspaceIndexStatusProvider,
  listWorkspaceRoots,
  onWorkspaceRootsChanged,
  primeWorkspaceRoots,
  registerWorkspaceIndexStatusProvider,
  resetWorkspaceRootEventsForTests,
  syncWorkspaceRoots
} from './workspace-root-events'

function repo(id: string, path: string, extra: Partial<Repo> = {}): Repo {
  return { id, path, displayName: id, badgeColor: '#000', addedAt: 0, kind: 'git', ...extra }
}

const root = '/Users/me/pod'

afterEach(() => {
  resetWorkspaceRootEventsForTests()
})

describe('computeWorkspaceRoots', () => {
  it('keeps local git repos under the root only', () => {
    const roots = computeWorkspaceRoots(
      [
        repo('a', '/Users/me/pod/acme/a'),
        repo('outside', '/Users/me/src/b'),
        repo('folder', '/Users/me/pod/notes', { kind: 'folder' }),
        repo('ssh', '/Users/me/pod/remote', { connectionId: 'box' }),
        repo('runtime', '/Users/me/pod/server', { executionHostId: 'runtime:env-1' })
      ],
      root,
      true
    )
    expect([...roots]).toEqual([['a', '/Users/me/pod/acme/a']])
  })

  it('matches repos stored under the real path of a symlinked root', () => {
    const base = mkdtempSync(join(tmpdir(), 'pod-root-alias-'))
    try {
      const real = join(base, 'real')
      mkdirSync(join(real, 'acme', 'a'), { recursive: true })
      symlinkSync(real, join(base, 'link'))
      const stored = join(realpathSync(real), 'acme', 'a')
      const roots = computeWorkspaceRoots([repo('a', stored)], join(base, 'link'), true)
      expect([...roots.keys()]).toEqual(['a'])
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('is empty while the workspace is off', () => {
    expect(computeWorkspaceRoots([repo('a', '/Users/me/pod/a')], root, false).size).toBe(0)
  })
})

describe('syncWorkspaceRoots', () => {
  it('starts silent, then emits added, moved and removed', () => {
    const listener = vi.fn()
    onWorkspaceRootsChanged(listener)
    primeWorkspaceRoots(new Map([['a', '/Users/me/pod/acme/a']]))
    expect(listener).not.toHaveBeenCalled()
    expect(listWorkspaceRoots()).toEqual([{ repoId: 'a', path: '/Users/me/pod/acme/a' }])

    syncWorkspaceRoots(
      new Map([
        ['a', '/Users/me/pod/acme-co/a'],
        ['b', '/Users/me/pod/acme/b']
      ])
    )
    syncWorkspaceRoots(new Map([['b', '/Users/me/pod/acme/b']]))

    expect(listener.mock.calls.map(([event]) => event)).toEqual([
      {
        kind: 'moved',
        repoId: 'a',
        path: '/Users/me/pod/acme-co/a',
        previousPath: '/Users/me/pod/acme/a'
      },
      { kind: 'added', repoId: 'b', path: '/Users/me/pod/acme/b' },
      { kind: 'removed', repoId: 'a', path: '/Users/me/pod/acme-co/a' }
    ])
  })

  it('turns a root change into removals and additions', () => {
    const repos = [repo('a', '/Users/me/pod/a'), repo('b', '/Users/me/code/b')]
    primeWorkspaceRoots(computeWorkspaceRoots(repos, root, true))
    const events = syncWorkspaceRoots(computeWorkspaceRoots(repos, '/Users/me/code', true))
    expect(events).toEqual([
      { kind: 'removed', repoId: 'a', path: '/Users/me/pod/a' },
      { kind: 'added', repoId: 'b', path: '/Users/me/code/b' }
    ])
  })

  it('keeps notifying after one listener throws, and stops after unsubscribe', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const healthy = vi.fn()
    onWorkspaceRootsChanged(() => {
      throw new Error('boom')
    })
    const unsubscribe = onWorkspaceRootsChanged(healthy)
    syncWorkspaceRoots(new Map([['a', '/Users/me/pod/a']]))
    unsubscribe()
    syncWorkspaceRoots(new Map())
    expect(healthy).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})

describe('registerWorkspaceIndexStatusProvider', () => {
  it('registers one provider and unregisters only itself', () => {
    const first = vi.fn(async () => null)
    const second = vi.fn(async () => null)
    const dropFirst = registerWorkspaceIndexStatusProvider(first)
    registerWorkspaceIndexStatusProvider(second)
    dropFirst()
    expect(getWorkspaceIndexStatusProvider()).toBe(second)
  })
})
