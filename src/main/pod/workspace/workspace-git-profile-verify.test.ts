import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createWorkspaceGitExec } from './workspace-git-exec'
import { createWorkspaceGitProfile } from './workspace-git-profile'
import { createWorkspaceJournal } from './workspace-journal'
import { createWorkspacePlanStore } from './workspace-plan-store'
import { createRealGitFixture, type RealGitFixture } from './workspace-real-git-test-fixture'

describe('workspace git profile: verify and relative worktrees (real git)', () => {
  let fx: RealGitFixture
  let repo: string
  let loaded: Set<string>

  beforeEach(async () => {
    fx = await createRealGitFixture('pod-ws-verify-')
    ;({ repo } = await fx.cloneWithOrigin('app'))
    // Present agents mean Pod never writes or loads launchd jobs from a test.
    const agents = join(fx.home, 'Library', 'LaunchAgents')
    mkdirSync(agents, { recursive: true })
    for (const schedule of ['hourly', 'daily', 'weekly']) {
      writeFileSync(join(agents, `org.git-scm.git.${schedule}.plist`), '')
    }
    loaded = new Set(['org.git-scm.git.hourly', 'org.git-scm.git.daily', 'org.git-scm.git.weekly'])
  })

  afterEach(() => fx.dispose())

  const profile = () =>
    createWorkspaceGitProfile({
      git: createWorkspaceGitExec(),
      home: fx.home,
      journal: createWorkspaceJournal(join(fx.root, 'journal.json')),
      plans: createWorkspacePlanStore(),
      getRepo: (id) => (id === 'repo-1' ? fx.repoRecord(repo) : undefined),
      isLaunchdJobLoaded: async (label) => loaded.has(label)
    })
  const local = (key: string) => fx.git(repo, 'config', '--local', key).then((out) => out.trim())

  it('verifies what an apply set, times status before and after, and names what drifted', async () => {
    const service = profile()
    const applied = await service.apply((await service.plan('repo-1')).planId)
    expect(applied.tune?.statusMsBefore).toEqual(expect.any(Number))
    expect(await local('fetch.prune')).toBe('true')

    const good = await service.verify('repo-1')
    expect(Object.fromEntries(good.checks.map((check) => [check.id, check.ok]))).toEqual({
      keys: true,
      maintenance: true,
      scheduler: true
    })
    expect(good.statusMs).toEqual(expect.any(Number))
    expect(good.statusMsBefore).toBe(applied.tune?.statusMsBefore)

    // One of the launchd agents went away.
    loaded.delete('org.git-scm.git.daily')
    const drifted = await service.verify('repo-1')
    expect(drifted.checks.find((check) => check.id === 'scheduler')).toMatchObject({
      ok: false,
      detail: 'not loaded: org.git-scm.git.daily'
    })
  })

  it('links worktrees by relative path only when ticked, and puts the format back on undo', async () => {
    const side = join(fx.root, 'side')
    await fx.git(repo, 'worktree', 'add', '-q', '-b', 'side', side)
    const service = profile()
    const plan = await service.plan('repo-1')
    expect(plan.optIns.find((optIn) => optIn.id === 'relative-worktrees')?.available).toBe(true)

    const applied = await service.apply(plan.planId, ['relative-worktrees'])
    expect(applied.tune?.relativeWorktreesBefore).toEqual({ extension: null, formatVersion: '0' })
    expect(readFileSync(join(side, '.git'), 'utf8')).toMatch(/^gitdir: \.\.\//)
    expect(await local('extensions.relativeWorktrees')).toBe('true')
    expect(await fx.git(side, 'status', '--porcelain')).toBe('')
    const after = await service.plan('repo-1')
    expect(after.optIns.find((optIn) => optIn.id === 'relative-worktrees')?.active).toBe(true)

    await service.undo(after.planId, applied.tune?.id ?? '')
    expect(readFileSync(join(side, '.git'), 'utf8')).toBe(
      `gitdir: ${join(repo, '.git', 'worktrees', 'side')}\n`
    )
    await expect(local('extensions.relativeWorktrees')).rejects.toThrow()
    await expect(local('worktree.useRelativePaths')).rejects.toThrow()
    expect(await local('core.repositoryformatversion')).toBe('0')
    expect(await fx.git(side, 'status', '--porcelain')).toBe('')
  })

  it('undoes a relative-worktrees apply whose repair failed half way', async () => {
    const side = join(fx.root, 'side')
    await fx.git(repo, 'worktree', 'add', '-q', '-b', 'side', side)
    const real = createWorkspaceGitExec()
    let failRepair = true
    // git turns the extension on, then the repair fails: what a crash part way would leave.
    const git: typeof real = async (args, cwd, options) => {
      if (failRepair && args[0] === 'worktree' && args[1] === 'repair') {
        await real(args, cwd, options)
        return { code: 1, stdout: '', stderr: 'repair failed' }
      }
      return real(args, cwd, options)
    }
    const service = createWorkspaceGitProfile({
      git,
      home: fx.home,
      journal: createWorkspaceJournal(join(fx.root, 'journal.json')),
      plans: createWorkspacePlanStore(),
      getRepo: (id) => (id === 'repo-1' ? fx.repoRecord(repo) : undefined),
      isLaunchdJobLoaded: async () => true
    })
    await expect(
      service.apply((await service.plan('repo-1')).planId, ['relative-worktrees'])
    ).rejects.toThrow(/repair failed/)
    const [tune] = (await service.plan('repo-1')).tunes
    expect(tune.relativeWorktreesBefore).toEqual({ extension: null, formatVersion: '0' })
    failRepair = false
    await service.undo((await service.plan('repo-1')).planId, tune.id)
    await expect(local('worktree.useRelativePaths')).rejects.toThrow()
    await expect(local('extensions.relativeWorktrees')).rejects.toThrow()
    expect(await local('core.repositoryformatversion')).toBe('0')
    expect(readFileSync(join(side, '.git'), 'utf8')).toMatch(/^gitdir: \//)
  })
})
