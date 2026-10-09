import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { Repo } from '../../../shared/repo-types'
import {
  registerWorkspaceIndexStatusProvider,
  resetWorkspaceRootEventsForTests
} from './workspace-root-events'
import type { WorkspaceGitRunner } from './workspace-repo-inventory'
import { createWorkspaceStatusService } from './workspace-status'
import type { WorkspaceToolRunner } from './workspace-tool-runner'

const dirs: string[] = []
afterEach(() => {
  resetWorkspaceRootEventsForTests()
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'pod-status-'))
  dirs.push(home)
  const root = join(home, 'pod')
  const inside = join(root, 'acme', 'widget')
  mkdirSync(join(inside, 'node_modules'), { recursive: true })
  const repos: Repo[] = [
    { id: 'in', path: inside, displayName: 'widget', badgeColor: '#000', addedAt: 0, kind: 'git' },
    {
      id: 'out',
      path: join(home, 'src', 'other'),
      displayName: 'other',
      badgeColor: '#000',
      addedAt: 0,
      kind: 'git'
    },
    {
      id: 'ssh',
      path: join(root, 'remote'),
      displayName: 'remote',
      badgeColor: '#000',
      addedAt: 0,
      kind: 'git',
      connectionId: 'box'
    }
  ]
  const settings: Pick<GlobalSettings, 'podWorkspaceRoot'> = { podWorkspaceRoot: root }
  const run = vi.fn<WorkspaceToolRunner>(async (tool, args) => {
    if (tool === 'tmutil' && args[0] === 'isexcluded') {
      return {
        code: 0,
        stdout: args
          .slice(1)
          .map((path) => `[Included]  ${path}`)
          .join('\n'),
        stderr: '',
        timedOut: false
      }
    }
    if (tool === 'tmutil' && args[0] === 'destinationinfo') {
      return { code: 0, stdout: '', stderr: 'No destinations configured', timedOut: false }
    }
    return { code: 0, stdout: '', stderr: '', timedOut: false }
  })
  const git = vi.fn<WorkspaceGitRunner>(async (args, cwd) => {
    if (args[0] === 'rev-parse') {
      return 'main\n'
    }
    if (args[0] === 'worktree') {
      return `worktree ${cwd}\n`
    }
    return args[0] === 'config' ? 'core.untrackedcache true\n' : ''
  })
  const service = createWorkspaceStatusService({
    store: {
      getSettings: () => settings,
      getRepos: () => repos
    },
    run,
    git,
    home,
    validation: { readDesktopDocumentsSync: async () => 'off' }
  })
  return { service, run, git, root, inside, home }
}

describe('createWorkspaceStatusService', () => {
  it('splits local git repos by the root and leaves SSH projects out', async () => {
    const { service, inside, home } = setup()
    const status = await service.getStatus()
    expect(status.repos).toEqual([
      expect.objectContaining({
        repoId: 'in',
        path: inside,
        branch: 'main',
        worktreeCount: 1,
        index: null
      })
    ])
    expect(status.repos[0].gitTuning?.untrackedCache).toBe('true')
    expect(status.outsideRepos.map((repo) => repo.repoId)).toEqual(['out'])
    expect(status.timeMachine).toEqual({
      destination: 'none',
      excluded: [],
      missing: [join(inside, 'node_modules')]
    })
    expect(status.indexConnected).toBe(false)
    expect(status.migrationScript).toEqual({
      path: join(home, '.local', 'share', 'pod-migrate', 'migrate.sh'),
      exists: false
    })
  })

  it('coalesces concurrent requests and reuses a fresh snapshot', async () => {
    const { service, git } = setup()
    const [first, second] = await Promise.all([service.getStatus(), service.getStatus()])
    expect(second).toBe(first)
    await service.getStatus()
    const revParseCalls = git.mock.calls.filter(([args]) => args[0] === 'rev-parse')
    expect(revParseCalls).toHaveLength(1)
  })

  it('reads index status from the registered provider, bounded by a timeout', async () => {
    const { service, inside } = setup()
    registerWorkspaceIndexStatusProvider(async (path) =>
      path === inside
        ? { state: 'ready', docs: 12, generation: 3, settled: true, buildMs: 40 }
        : null
    )
    const status = await service.getStatus({ refresh: true })
    expect(status.indexConnected).toBe(true)
    expect(status.repos[0].index).toEqual({
      state: 'ready',
      docs: 12,
      generation: 3,
      settled: true,
      buildMs: 40
    })
  })

  it('excludes the missing build folders in one tmutil call', async () => {
    const { service, run } = setup()
    const result = await service.excludeBuildFolders()
    expect(result.destination).toBe('none')
    const adds = run.mock.calls.filter(
      ([tool, args]) => tool === 'tmutil' && args[0] === 'addexclusion'
    )
    expect(adds).toHaveLength(1)
  })
})
