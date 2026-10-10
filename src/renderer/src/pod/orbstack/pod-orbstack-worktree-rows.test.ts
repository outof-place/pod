import { describe, expect, it } from 'vitest'
import type { PodOrbstackContainer, PodOrbstackStatus } from '../../../../shared/pod-orbstack-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { buildPodOrbstackWorktreeRows } from './pod-orbstack-worktree-rows'

function repo(id: string, overrides: Partial<Repo> = {}): Repo {
  return {
    id,
    path: `/Users/me/${id}`,
    displayName: id,
    badgeColor: '#000',
    addedAt: 0,
    ...overrides
  }
}

function worktree(
  repoId: string,
  path: string
): Pick<Worktree, 'id' | 'path' | 'displayName' | 'isBare'> {
  return {
    id: `${repoId}::${path}`,
    path,
    displayName: path.split('/').at(-1) ?? '',
    isBare: false
  }
}

function container(id: string, workingDir: string | null): PodOrbstackContainer {
  return {
    id,
    name: id,
    image: 'nginx',
    state: 'running',
    status: 'Up',
    composeProject: workingDir ? 'p' : null,
    composeWorkingDir: workingDir,
    cpuPercent: null,
    memoryUsage: null
  }
}

function status(overrides: Partial<PodOrbstackStatus>): PodOrbstackStatus {
  return {
    install: {
      appInstalled: true,
      orbPath: '/bin/orb',
      dockerPath: '/bin/docker',
      version: '2.2.3'
    },
    service: 'running',
    dockerContext: { current: 'orbstack', currentIsOrbstack: true, orbstackContextExists: true },
    machines: [],
    containers: [],
    links: [],
    busyWorktreeIds: [],
    errors: [],
    checkedAt: 0,
    ...overrides
  }
}

describe('buildPodOrbstackWorktreeRows', () => {
  const repos = [repo('web'), repo('remote', { connectionId: 'ssh-1' })]
  const worktreesByRepo = {
    web: [worktree('web', '/Users/me/web'), worktree('web', '/Users/me/web/.worktrees/feature')],
    remote: [worktree('remote', '/home/me/remote')]
  }

  it('lists local worktrees with their machine, pin and compose containers', () => {
    const rows = buildPodOrbstackWorktreeRows(
      repos,
      worktreesByRepo,
      status({
        machines: [
          {
            name: 'pod-web-1',
            state: 'running',
            distro: 'ubuntu',
            distroVersion: 'noble',
            arch: 'arm64',
            podOwned: true,
            worktreeId: 'web::/Users/me/web',
            missing: false
          }
        ],
        links: [{ worktreeId: 'web::/Users/me/web', machine: 'pod-web-1', dockerPinned: true }],
        containers: [
          container('a', '/Users/me/web'),
          container('b', '/Users/me/web/.worktrees/feature/app'),
          container('c', '/Users/me/website'),
          container('d', null)
        ],
        busyWorktreeIds: ['web::/Users/me/web/.worktrees/feature']
      })
    )

    expect(rows.map((row) => row.path)).toEqual([
      '/Users/me/web',
      '/Users/me/web/.worktrees/feature'
    ])
    expect(rows[0]).toMatchObject({
      machine: { name: 'pod-web-1' },
      dockerPinned: true,
      busy: false
    })
    expect(rows[0].containers.map((entry) => entry.id)).toEqual(['a'])
    expect(rows[1]).toMatchObject({ machine: null, dockerPinned: false, busy: true })
    expect(rows[1].containers.map((entry) => entry.id)).toEqual(['b'])
  })
})
