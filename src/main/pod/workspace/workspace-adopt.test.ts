import { existsSync, lstatSync, mkdirSync, readlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claudeProjectKey, createWorkspaceAdopt } from './workspace-adopt'
import { createWorkspaceGitExec } from './workspace-git-exec'
import { createWorkspaceJournal } from './workspace-journal'
import { createWorkspacePlanStore } from './workspace-plan-store'
import type { ProcessCwdReader } from './workspace-process-cwds'
import { createRealGitFixture, type RealGitFixture } from './workspace-real-git-test-fixture'

describe('workspace adopt (real git)', () => {
  let fx: RealGitFixture
  let repo: string
  let podRoot: string
  let cwds: Map<number, string>
  let plans: ReturnType<typeof createWorkspacePlanStore>

  const processes: ProcessCwdReader = {
    listPids: () => [...cwds.keys()],
    readCwd: (pid) => cwds.get(pid) ?? null,
    readNames: async () => new Map()
  }

  beforeEach(async () => {
    fx = await createRealGitFixture('pod-ws-adopt-')
    ;({ repo } = await fx.cloneWithOrigin('app'))
    await fx.git(repo, 'remote', 'set-url', 'origin', 'git@github.com:acme/app.git')
    podRoot = join(fx.root, 'pod')
    mkdirSync(podRoot)
    cwds = new Map()
    plans = createWorkspacePlanStore()
  })

  afterEach(() => fx.dispose())

  const adopt = () =>
    createWorkspaceAdopt({
      git: createWorkspaceGitExec(),
      journal: createWorkspaceJournal(join(fx.root, 'journal.json')),
      plans,
      processes,
      getRepo: () => fx.repoRecord(repo),
      root: () => podRoot,
      home: fx.home
    })

  it('moves the repo to <root>/<owner>/<repo>, keeps the old path working and undoes it', async () => {
    // One worktree in Pod's sibling layout (moves along), one elsewhere (stays, gets repaired).
    const sibling = join(`${repo}.worktrees`, 'feature')
    const linked = join(fx.root, 'app-elsewhere')
    await fx.git(repo, 'worktree', 'add', '-q', '-b', 'feature', sibling)
    await fx.git(repo, 'worktree', 'add', '-q', '-b', 'elsewhere', linked)
    const claude = join(fx.home, '.claude', 'projects', claudeProjectKey(repo))
    mkdirSync(claude, { recursive: true })
    writeFileSync(join(claude, 'session.jsonl'), '{}\n')

    const service = adopt()
    const plan = await service.plan('repo-1')
    const target = join(podRoot, 'acme', 'app')
    expect(plan).toMatchObject({
      from: repo,
      to: target,
      blockers: [],
      linkedWorktrees: expect.arrayContaining([sibling, linked]),
      worktreesDir: `${repo}.worktrees`
    })
    expect(plan.claudeProjectDir).toBe(claude)

    const record = await service.apply(plan.planId)
    await expect(service.apply(plan.planId)).rejects.toThrow(/expired/)
    expect(lstatSync(repo).isSymbolicLink()).toBe(true)
    expect(readlinkSync(repo)).toBe(target)
    // git follows the move in the linked worktree, not just through the symlink.
    expect(await fx.git(linked, 'rev-parse', '--git-common-dir')).toContain(target)
    expect(await fx.git(linked, 'status', '--porcelain')).toBe('')
    expect(readlinkSync(`${repo}.worktrees`)).toBe(`${target}.worktrees`)
    expect(await fx.git(join(`${target}.worktrees`, 'feature'), 'status', '--porcelain')).toBe('')
    expect(await fx.git(target, 'worktree', 'list', '--porcelain')).not.toContain('prunable')
    expect(
      existsSync(join(fx.home, '.claude', 'projects', claudeProjectKey(target), 'session.jsonl'))
    ).toBe(true)
    expect(lstatSync(claude).isSymbolicLink()).toBe(true)

    const undoPlan = await service.planUndo(record.id)
    expect(undoPlan.blockers).toEqual([])
    await service.undo(undoPlan.planId)
    expect(lstatSync(repo).isDirectory()).toBe(true)
    expect(existsSync(target)).toBe(false)
    expect(await fx.git(linked, 'rev-parse', '--git-common-dir')).toContain(repo)
    expect(lstatSync(`${repo}.worktrees`).isDirectory()).toBe(true)
    expect(await fx.git(repo, 'worktree', 'list', '--porcelain')).not.toContain('prunable')
    expect(lstatSync(claude).isDirectory()).toBe(true)
  })

  it('refuses when the target exists, whatever the user ticks', async () => {
    mkdirSync(join(podRoot, 'acme', 'app'), { recursive: true })
    const service = adopt()
    const plan = await service.plan('repo-1')
    expect(plan.blockers).toEqual(['target-exists'])
    await expect(service.apply(plan.planId, ['process-inside'])).rejects.toThrow(/target-exists/)
    expect(lstatSync(repo).isDirectory()).toBe(true)
  })

  it('moves with a process inside only once the user ticked it', async () => {
    cwds.set(77, join(repo, 'src'))
    const service = adopt()
    const plan = await service.plan('repo-1')
    expect(plan.blockers).toEqual(['process-inside'])
    await expect(service.apply(plan.planId)).rejects.toThrow(/process-inside/)
    expect(lstatSync(repo).isDirectory()).toBe(true)
    const record = await service.apply(plan.planId, ['process-inside'])
    // Moving back under a running process is refused outright.
    cwds.set(77, join(record.to, 'src'))
    const undoPlan = await service.planUndo(record.id)
    expect(undoPlan.blockers).toEqual(['process-inside'])
    await expect(service.undo(undoPlan.planId)).rejects.toThrow(/Not moved back/)
  })

  it('refuses a plan the folder moved past', async () => {
    const service = adopt()
    const plan = await service.plan('repo-1')
    await fx.git(repo, 'worktree', 'add', '-q', '-b', 'late', join(fx.root, 'late'))
    await expect(service.apply(plan.planId)).rejects.toThrow(/changed since you looked/)
    expect(lstatSync(repo).isDirectory()).toBe(true)
  })

  it('puts a repo without an owner under _local', async () => {
    await fx.git(repo, 'remote', 'remove', 'origin')
    expect((await adopt().plan('repo-1')).to).toBe(join(podRoot, '_local', 'app'))
  })
})
