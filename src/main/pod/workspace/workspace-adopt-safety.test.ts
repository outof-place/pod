import { existsSync, lstatSync, mkdirSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PodAdoptRecord } from '../../../shared/pod-workspace-tidy-types'
import type { Repo } from '../../../shared/repo-types'
import type { PodOrbstackWorktreeKeys } from '../orbstack/pod-orbstack-worktree-keys'
import { createWorkspaceAdopt } from './workspace-adopt'
import { saveAdoptRecord } from './workspace-adopt-paths'
import type { AdoptRelinkRuntime } from './workspace-adopt-relink'
import { createAdoptRuntimeHooks } from './workspace-adopt-runtime'
import { createWorkspaceGitExec } from './workspace-git-exec'
import { createWorkspaceJournal } from './workspace-journal'
import { createWorkspacePlanStore } from './workspace-plan-store'
import { createRealGitFixture, type RealGitFixture } from './workspace-real-git-test-fixture'

describe('workspace adopt: what refuses, and Move Back after the fact (real git)', () => {
  let fx: RealGitFixture
  let repo: string
  let sibling: string
  let target: string
  let row: Repo
  let others: Repo[]
  let meta: Record<string, object>
  let live: string[]
  let machines: Map<string, string>
  let pins: string[]
  let automations: { name: string; workspaceMode: string; workspaceId: string | null }[]

  const id = (path: string) => `repo-1::${path}`
  const runtime: AdoptRelinkRuntime = {
    liveTerminalWorktrees: async (ids) => ids.filter((entry) => live.includes(entry)),
    notifyWorktreeRenamed: () => undefined,
    notifyReposChanged: () => undefined
  }
  const orbstack: PodOrbstackWorktreeKeys = {
    machinesFor: (ids) =>
      [...machines].filter(([, owner]) => ids.includes(owner)).map(([name]) => name),
    rekey: (pairs) => {
      const next = new Map(pairs)
      const moved = pins
        .filter((pin) => next.has(pin))
        .map((pin): [string, string] => [pin, next.get(pin) ?? pin])
      pins = pins.map((pin) => next.get(pin) ?? pin)
      return moved
    }
  }

  beforeEach(async () => {
    fx = await createRealGitFixture('pod-ws-safety-')
    ;({ repo } = await fx.cloneWithOrigin('app'))
    await fx.git(repo, 'remote', 'set-url', 'origin', 'git@github.com:acme/app.git')
    sibling = join(`${repo}.worktrees`, 'feature')
    await fx.git(repo, 'worktree', 'add', '-q', '-b', 'feature', sibling)
    target = join(fx.root, 'pod', 'acme', 'app')
    mkdirSync(join(fx.root, 'pod'))
    row = fx.repoRecord(repo)
    others = []
    meta = { [id(repo)]: {}, [id(sibling)]: {} }
    live = []
    machines = new Map()
    pins = []
    automations = []
  })

  afterEach(() => fx.dispose())

  const adopt = () =>
    createWorkspaceAdopt({
      git: createWorkspaceGitExec(),
      journal: createWorkspaceJournal(join(fx.root, 'journal.json')),
      plans: createWorkspacePlanStore(),
      processes: null,
      getRepo: () => row,
      allRepos: () => [row, ...others],
      orbstack: () => orbstack,
      store: {
        getAllWorktreeMeta: () => meta,
        migrateWorktreeIdentity: (from, to) => {
          meta[to] = meta[from]
          delete meta[from]
        },
        updateRepo: (_id, updates) => Object.assign(row, updates),
        listAutomations: () => automations
      },
      root: () => join(fx.root, 'pod'),
      home: fx.home,
      historyRoot: join(fx.root, 'terminal-history')
    })

  it('refuses a worktree with OrbStack machines, and carries its docker pin otherwise', async () => {
    machines.set('pod-feature', id(sibling))
    const refused = await adopt().plan('repo-1', runtime)
    expect(refused.blockers).toContain('orbstack-machines')
    expect(refused.relink.orbstackMachines).toEqual(['pod-feature'])

    machines.clear()
    pins = [id(sibling)]
    const service = adopt()
    const record = await service.apply((await service.plan('repo-1', runtime)).planId, [], runtime)
    const movedSibling = join(`${target}.worktrees`, 'feature')
    expect(pins).toEqual([id(movedSibling)])
    expect(record.relink?.orbstackKeys).toEqual([[id(sibling), id(movedSibling)]])
    await service.undo((await service.planUndo(record.id, runtime)).planId, runtime)
    expect(pins).toEqual([id(sibling)])
  })

  it('refuses a project nested inside, and a repo that holds the root', async () => {
    others = [{ ...fx.repoRecord(join(repo, 'vendor', 'lib'), 'repo-2') }]
    expect((await adopt().plan('repo-1', runtime)).blockers).toContain('nested-project')
    others = []
    row = fx.repoRecord(fx.root)
    expect((await adopt().plan('repo-1', runtime)).blockers).toContain('contains-root')
  })

  it('names automations bound to a worktree that moves', async () => {
    automations = [
      { name: 'Nightly', workspaceMode: 'existing', workspaceId: id(sibling) },
      { name: 'Fresh', workspaceMode: 'new_per_run', workspaceId: null }
    ]
    const plan = await adopt().plan('repo-1', runtime)
    expect(plan.warnings).toContainEqual({ kind: 'automations', names: ['Nightly'] })
  })

  it('keeps a config value the user changed after the move, and adds none on Move Back', async () => {
    await fx.git(repo, 'config', 'core.hooksPath', `${repo}/.husky/_`)
    const service = adopt()
    const record = await service.apply((await service.plan('repo-1', runtime)).planId, [], runtime)
    // What husky does on its next install: the relative value.
    await fx.git(target, 'config', 'core.hooksPath', '.husky/_')
    await service.undo((await service.planUndo(record.id, runtime)).planId, runtime)
    expect(await fx.git(repo, 'config', '--get-all', 'core.hooksPath')).toBe('.husky/_\n')
  })

  it('refuses Move Back under a live terminal, or when a link at the old place changed', async () => {
    const service = adopt()
    const record = await service.apply((await service.plan('repo-1', runtime)).planId, [], runtime)
    const movedSibling = join(`${target}.worktrees`, 'feature')
    live = [id(movedSibling)]
    expect((await service.planUndo(record.id, runtime)).blockers).toEqual(['terminals-open'])
    live = []
    rmSync(`${repo}.worktrees`)
    mkdirSync(`${repo}.worktrees`)
    const plan = await service.planUndo(record.id, runtime)
    expect(plan.blockers).toEqual(['link-changed'])
    await expect(service.undo(plan.planId, runtime)).rejects.toThrow(/link-changed/)
    // Nothing went back, and the record stays for a retry.
    expect(lstatSync(repo).isSymbolicLink()).toBe(true)
    expect(
      (await createWorkspaceJournal(join(fx.root, 'journal.json')).read()).adoptions
    ).toHaveLength(1)
    rmSync(`${repo}.worktrees`, { recursive: true })
    symlinkSync(`${target}.worktrees`, `${repo}.worktrees`)
    await service.undo((await service.planUndo(record.id, runtime)).planId, runtime)
    expect(lstatSync(repo).isDirectory()).toBe(true)
  })

  it('takes back a move that crashed in a rename, and skips a folder that never left', async () => {
    const journal = createWorkspaceJournal(join(fx.root, 'journal.json'))
    // What the journal holds when a crash cuts the apply short, before the next save.
    const crashedAt = (state: Partial<PodAdoptRecord>) =>
      saveAdoptRecord(journal, {
        id: 'crash',
        repoId: 'repo-1',
        from: repo,
        to: target,
        movedAt: 1,
        repoMoved: false,
        worktreesDirMoved: false,
        claudeProjectDirMoved: false,
        progress: 'moving',
        renaming: 'repo',
        ...state
      })
    const moveBack = async () => {
      const service = adopt()
      const plan = await service.planUndo('crash', runtime)
      expect(plan.blockers).toEqual([])
      await service.undo(plan.planId, runtime)
    }
    const isBack = () => lstatSync(repo).isDirectory() && !existsSync(target)
    mkdirSync(dirname(target), { recursive: true })

    renameSync(repo, target)
    symlinkSync(target, repo)
    await crashedAt({})
    await moveBack()
    expect(isBack()).toBe(true)

    renameSync(repo, target)
    await crashedAt({})
    await moveBack()
    expect(isBack()).toBe(true)

    await crashedAt({})
    await moveBack()
    expect(isBack()).toBe(true)
    expect((await journal.read()).adoptions).toEqual([])

    renameSync(repo, target)
    symlinkSync(target, repo)
    renameSync(`${repo}.worktrees`, `${target}.worktrees`)
    symlinkSync(`${target}.worktrees`, `${repo}.worktrees`)
    await crashedAt({ repoMoved: true, renaming: 'worktrees' })
    await moveBack()
    expect(isBack()).toBe(true)
    expect(lstatSync(`${repo}.worktrees`).isDirectory()).toBe(true)
    expect(await fx.git(sibling, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature\n')
  })

  it('takes back a worktree added under the new folder after the move', async () => {
    const service = adopt()
    const record = await service.apply((await service.plan('repo-1', runtime)).planId, [], runtime)
    const late = join(`${target}.worktrees`, 'late')
    await fx.git(target, 'worktree', 'add', '-q', '-b', 'late', late)
    meta[id(late)] = { comment: 'late' }
    await service.undo((await service.planUndo(record.id, runtime)).planId, runtime)
    expect(meta[id(join(`${repo}.worktrees`, 'late'))]).toEqual({ comment: 'late' })
  })
})

describe('the live-terminal check', () => {
  const surface = (fail: (worktreeId: string) => Error | null) => ({
    listTerminals: async (selector?: string) => {
      const error = fail(selector ?? '')
      if (error) {
        throw error
      }
      return { terminals: [], totalCount: 0, truncated: false }
    },
    notifyWorktreeFolderRenamed: () => undefined,
    notifyFolderWorkspaceChanged: () => undefined
  })

  it('counts a worktree it could not check as open, except one the runtime does not know', async () => {
    const hooks = createAdoptRuntimeHooks(
      surface((selector) =>
        selector === 'id:gone'
          ? new Error('selector_not_found')
          : selector === 'id:busy'
            ? new Error('timeout')
            : null
      )
    )
    expect(await hooks.liveTerminalWorktrees(['gone', 'busy', 'idle'])).toEqual(['busy'])
  })
})
