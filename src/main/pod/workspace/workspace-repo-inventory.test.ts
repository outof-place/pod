import { describe, expect, it, vi } from 'vitest'
import {
  listTrackedRootFiles,
  parseGitTuning,
  parseWorktreePaths,
  readRepoGitInfo,
  type WorkspaceGitRunner
} from './workspace-repo-inventory'

describe('parseGitTuning', () => {
  it('reads canonical keys, bare booleans, and keeps the last value', () => {
    expect(
      parseGitTuning(
        [
          'core.untrackedcache true',
          'core.fsmonitor',
          'index.version 2',
          'index.version 4',
          'checkout.workers 0',
          'orca.performanceconfig 1',
          'core.other ignored'
        ].join('\n')
      )
    ).toEqual({
      untrackedCache: 'true',
      fsmonitor: 'true',
      indexVersion: '4',
      checkoutWorkers: '0',
      orcaPerformanceConfig: '1'
    })
  })

  it('reports nothing set when git found no keys', () => {
    expect(parseGitTuning(null)).toEqual({
      untrackedCache: null,
      fsmonitor: null,
      indexVersion: null,
      checkoutWorkers: null,
      orcaPerformanceConfig: null
    })
  })
})

describe('repo git info', () => {
  it('parses worktree porcelain', () => {
    expect(
      parseWorktreePaths(
        'worktree /p/acme/a\nHEAD abc\nbranch refs/heads/main\n\nworktree /p/acme/a.worktrees/x\nHEAD def\ndetached\n'
      )
    ).toEqual(['/p/acme/a', '/p/acme/a.worktrees/x'])
    expect(parseWorktreePaths(null)).toBeNull()
  })

  it('reads branch, worktrees and tuning with read-only commands', async () => {
    const git = vi.fn<WorkspaceGitRunner>(async (args) => {
      if (args[0] === 'rev-parse') {
        return 'HEAD\n'
      }
      if (args[0] === 'worktree') {
        return 'worktree /p/a\n'
      }
      return null
    })
    const info = await readRepoGitInfo('/p/a', git)
    expect(info).toMatchObject({ branch: null, worktreePaths: ['/p/a'] })
    expect(info.gitTuning.untrackedCache).toBeNull()
    expect(git.mock.calls.map(([args]) => args[0])).toEqual(['rev-parse', 'worktree', 'config'])
    expect(git.mock.calls[2][0]).toEqual([
      'config',
      '--get-regexp',
      '^(core\\.untrackedcache|core\\.fsmonitor|index\\.version|checkout\\.workers|orca\\.performanceconfig)$'
    ])
  })

  it('lists which probe names git tracks at the root', async () => {
    const git: WorkspaceGitRunner = async () => 'package.json\nREADME.md\n'
    expect(
      await listTrackedRootFiles('/p/a', ['README.md', 'Cargo.toml', 'package.json'], git)
    ).toEqual(['README.md', 'package.json'])
  })
})
