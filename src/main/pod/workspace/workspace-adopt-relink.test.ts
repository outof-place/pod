import { existsSync, lstatSync, mkdirSync, readlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Repo } from '../../../shared/repo-types'
import { hashWorktreeId } from '../../terminal-history-id'
import { claudeProjectKey, createWorkspaceAdopt } from './workspace-adopt'
import type { AdoptRelinkRuntime } from './workspace-adopt-relink'
import { createWorkspaceGitExec } from './workspace-git-exec'
import { createWorkspaceJournal } from './workspace-journal'
import { createWorkspacePlanStore } from './workspace-plan-store'
import { createRealGitFixture, type RealGitFixture } from './workspace-real-git-test-fixture'

describe('workspace adopt relink (real git)', () => {
  let fx: RealGitFixture
  let repo: string
  let sibling: string
  let elsewhere: string
  let target: string
  let row: Repo
  let meta: Record<string, { comment: string }>
  let renamed: [string, string][]
  let reposChanged: number
  let live: string[]
  let failRepoUpdate: boolean

  const id = (path: string) => `repo-1::${path}`
  const claude = (path: string) => join(fx.home, '.claude', 'projects', claudeProjectKey(path))
  const history = (path: string) => join(fx.root, 'terminal-history', hashWorktreeId(id(path)))

  const runtime: AdoptRelinkRuntime = {
    liveTerminalWorktrees: async (ids) => ids.filter((entry) => live.includes(entry)),
    notifyWorktreeRenamed: (_repoId, from, to) => void renamed.push([from, to]),
    notifyReposChanged: () => void reposChanged++
  }

  beforeEach(async () => {
    fx = await createRealGitFixture('pod-ws-relink-')
    ;({ repo } = await fx.cloneWithOrigin('app'))
    await fx.git(repo, 'remote', 'set-url', 'origin', 'git@github.com:acme/app.git')
    sibling = join(`${repo}.worktrees`, 'feature')
    elsewhere = join(fx.root, 'app-elsewhere')
    await fx.git(repo, 'worktree', 'add', '-q', '-b', 'feature', sibling)
    await fx.git(repo, 'worktree', 'add', '-q', '-b', 'elsewhere', elsewhere)
    target = join(fx.root, 'pod', 'acme', 'app')
    mkdirSync(join(fx.root, 'pod'))
    row = fx.repoRecord(repo)
    row.worktreeBasePath = `${repo}.worktrees`
    meta = { [id(repo)]: { comment: 'main' }, [id(sibling)]: { comment: 'feature' } }
    renamed = []
    reposChanged = 0
    live = []
    failRepoUpdate = false
  })

  afterEach(() => fx.dispose())

  const adopt = () =>
    createWorkspaceAdopt({
      git: createWorkspaceGitExec(),
      journal: createWorkspaceJournal(join(fx.root, 'journal.json')),
      plans: createWorkspacePlanStore(),
      processes: null,
      getRepo: () => row,
      allRepos: () => [row],
      store: {
        getAllWorktreeMeta: () => meta,
        migrateWorktreeIdentity: (from, to) => {
          meta[to] = meta[from]
          delete meta[from]
        },
        updateRepo: (_id, updates) => (failRepoUpdate ? null : Object.assign(row, updates))
      },
      root: () => join(fx.root, 'pod'),
      home: fx.home,
      historyRoot: join(fx.root, 'terminal-history')
    })

  it("carries Pod's records, Claude's folders and git's paths along, and takes them back", async () => {
    for (const path of [repo, sibling]) {
      mkdirSync(claude(path), { recursive: true })
      writeFileSync(join(claude(path), 'session.jsonl'), '{}\n')
      mkdirSync(history(path), { recursive: true })
    }
    await fx.git(repo, 'config', 'core.hooksPath', `${repo}/.husky/_`)
    await fx.git(repo, 'config', '--global', '--add', 'maintenance.repo', repo)

    const service = adopt()
    const plan = await service.plan('repo-1', runtime)
    expect(plan.blockers).toEqual([])
    expect(plan.relink.worktrees).toEqual(
      expect.arrayContaining([
        [repo, target],
        [sibling, join(`${target}.worktrees`, 'feature')]
      ])
    )
    // The worktree outside the moved folders keeps its path and its id.
    expect(plan.relink.worktrees.map(([from]) => from)).not.toContain(elsewhere)
    expect(plan.relink.claudeProjectDirs).toHaveLength(2)
    expect(plan.relink.historyDirs).toBe(2)
    expect(plan.relink.configPaths).toEqual([
      { scope: 'local', key: 'core.hookspath', from: `${repo}/.husky/_`, to: `${target}/.husky/_` },
      { scope: 'global', key: 'maintenance.repo', from: repo, to: target }
    ])

    const record = await service.apply(plan.planId, [], runtime)
    const movedSibling = join(`${target}.worktrees`, 'feature')
    expect(row.path).toBe(target)
    expect(row.worktreeBasePath).toBe(`${target}.worktrees`)
    expect(meta).toEqual({
      [id(target)]: { comment: 'main' },
      [id(movedSibling)]: { comment: 'feature' }
    })
    expect(renamed).toEqual(
      expect.arrayContaining([
        [id(repo), id(target)],
        [id(sibling), id(movedSibling)]
      ])
    )
    expect(reposChanged).toBe(1)
    expect(existsSync(history(target))).toBe(true)
    expect(existsSync(history(repo))).toBe(false)
    expect(existsSync(join(claude(movedSibling), 'session.jsonl'))).toBe(true)
    expect(lstatSync(claude(sibling)).isSymbolicLink()).toBe(true)
    expect(await fx.git(target, 'config', 'core.hooksPath')).toBe(`${target}/.husky/_\n`)
    expect(await fx.git(target, 'config', '--global', '--get-all', 'maintenance.repo')).toBe(
      `${target}\n`
    )
    expect(record.relink?.worktreeIds).toHaveLength(2)

    const undoPlan = await service.planUndo(record.id)
    await service.undo(undoPlan.planId, runtime)
    expect(row.path).toBe(repo)
    expect(row.worktreeBasePath).toBe(`${repo}.worktrees`)
    expect(meta).toEqual({ [id(repo)]: { comment: 'main' }, [id(sibling)]: { comment: 'feature' } })
    expect(existsSync(history(repo))).toBe(true)
    expect(lstatSync(claude(sibling)).isDirectory()).toBe(true)
    expect(existsSync(claude(movedSibling))).toBe(false)
    expect(await fx.git(repo, 'config', 'core.hooksPath')).toBe(`${repo}/.husky/_\n`)
    expect(await fx.git(repo, 'config', '--global', '--get-all', 'maintenance.repo')).toBe(
      `${repo}\n`
    )
    expect(lstatSync(repo).isDirectory()).toBe(true)
  })

  it('refuses while a Pod terminal runs in a checkout that moves, whatever the user ticks', async () => {
    live = [id(sibling)]
    const service = adopt()
    const plan = await service.plan('repo-1', runtime)
    expect(plan.blockers).toEqual(['terminals-open'])
    expect(plan.relink.terminalsOpen).toEqual([sibling])
    await expect(service.apply(plan.planId, ['process-inside'], runtime)).rejects.toThrow(
      /terminals-open/
    )
    expect(lstatSync(repo).isDirectory()).toBe(true)
  })

  it('records a move that failed part way, so Move Back still takes it back', async () => {
    mkdirSync(claude(repo), { recursive: true })
    failRepoUpdate = true
    const service = adopt()
    const plan = await service.plan('repo-1', runtime)
    await expect(service.apply(plan.planId, [], runtime)).rejects.toThrow(/no longer in Pod/)
    const [record] = (await createWorkspaceJournal(join(fx.root, 'journal.json')).read()).adoptions
    expect(record.relink?.claudeProjectDirs).toEqual([[claude(repo), claude(target)]])
    expect(readlinkSync(repo)).toBe(target)

    const undoPlan = await service.planUndo(record.id)
    await service.undo(undoPlan.planId, runtime)
    expect(lstatSync(repo).isDirectory()).toBe(true)
    expect(lstatSync(claude(repo)).isDirectory()).toBe(true)
    expect(row.path).toBe(repo)
  })
})
