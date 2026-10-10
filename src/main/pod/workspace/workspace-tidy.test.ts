import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PodTidyAction, PodTidyWorktree } from '../../../shared/pod-workspace-tidy-types'
import { createWorkspaceGitExec } from './workspace-git-exec'
import { createWorkspaceJournal } from './workspace-journal'
import { createWorkspacePlanStore } from './workspace-plan-store'
import type { ProcessCwdReader } from './workspace-process-cwds'
import { createRealGitFixture, type RealGitFixture } from './workspace-real-git-test-fixture'
import { createWorkspaceTidyActions } from './workspace-tidy-actions'
import { scanWorkspaceTidy, TIDY_STALE_MS } from './workspace-tidy-scan'
import { createWorkspaceTrash } from './workspace-trash'

describe('workspace tidy (real git)', () => {
  let fx: RealGitFixture
  let repo: string
  let wtRoot: string
  let cwds: Map<number, string>
  let plans: ReturnType<typeof createWorkspacePlanStore>
  let osTrash: ReturnType<typeof vi.fn<(path: string) => Promise<void>>>

  const processes: ProcessCwdReader = {
    listPids: () => [...cwds.keys()],
    readCwd: (pid) => cwds.get(pid) ?? null,
    readNames: async (pids) => new Map(pids.map((pid) => [pid, `proc-${pid}`]))
  }

  const deps = () => ({
    git: createWorkspaceGitExec(),
    processes,
    journal: createWorkspaceJournal(join(fx.root, 'journal.json')),
    plans,
    store: fx.store([fx.repoRecord(repo)])
  })

  const actionsWith = (removeWorktree: (worktreeId: string) => Promise<void>) =>
    createWorkspaceTidyActions({
      ...deps(),
      getRepo: () => fx.repoRecord(repo),
      removeWorktree,
      trash: createWorkspaceTrash(fx.home, osTrash)
    })

  // What Orca's own removal leaves behind: no registration, no branch.
  const orcaRemoval = (path: string, branch: string) => async () => {
    await fx.git(repo, 'worktree', 'remove', '--force', path)
    await fx.git(repo, 'branch', '-D', branch)
  }

  const addWorktree = async (name: string) => {
    const path = join(wtRoot, name)
    await fx.git(repo, 'worktree', 'add', '-q', '-b', name, path, 'origin/main')
    return path
  }

  beforeEach(async () => {
    fx = await createRealGitFixture('pod-ws-tidy-')
    ;({ repo } = await fx.cloneWithOrigin('app'))
    wtRoot = `${repo}.worktrees`
    mkdirSync(wtRoot)
    cwds = new Map()
    plans = createWorkspacePlanStore()
    osTrash = vi.fn(async () => {})
  })

  afterEach(() => fx.dispose())

  const scanOne = async () => {
    const scan = await scanWorkspaceTidy(deps(), [fx.repoRecord(repo)])
    const byName = (name: string): PodTidyWorktree | undefined =>
      scan.worktrees.find((entry) => entry.path === join(wtRoot, name))
    return { scan, byName }
  }

  const applyOn = async (
    actions: ReturnType<typeof actionsWith>,
    action: PodTidyAction,
    acknowledged?: ('dirty' | 'unpushed' | 'process-inside')[]
  ) => actions.run({ planId: (await scanOne()).scan.planId, action, acknowledged })

  it('flags merged, gone, dirty, unpushed, prunable, stray and busy worktrees', async () => {
    const merged = await addWorktree('merged')
    await fx.commit(merged, 'a.txt', 'merged work')
    await fx.git(merged, 'push', '-q', 'origin', 'merged:main')
    await fx.git(repo, 'fetch', '-q', 'origin')

    const gone = await addWorktree('gone')
    await fx.commit(gone, 'g.txt', 'gone work')
    await fx.git(gone, 'push', '-q', '-u', 'origin', 'gone')
    await fx.git(gone, 'push', '-q', 'origin', '--delete', 'gone')
    await fx.git(repo, 'fetch', '-q', '--prune', 'origin')

    const dirty = await addWorktree('dirty')
    writeFileSync(join(dirty, 'scratch.txt'), 'untracked\n')

    const local = await addWorktree('local')
    await fx.commit(local, 'l.txt', 'local only')

    const vanished = await addWorktree('vanished')
    rmSync(vanished, { recursive: true, force: true })

    const busy = await addWorktree('busy')
    cwds.set(4242, join(busy, 'sub'))

    const stray = join(wtRoot, 'leftover')
    mkdirSync(stray)
    const old = (Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000
    utimesSync(stray, old, old)

    const { scan, byName } = await scanOne()
    expect(scan.errors).toEqual([])
    expect(scan.planId).toMatch(/^[0-9a-f-]{36}$/)
    expect(byName('merged')?.reasons).toContain('merged')
    expect(byName('merged')?.blockers).toEqual([])
    expect(byName('gone')?.reasons).toContain('upstream-gone')
    expect(byName('dirty')?.blockers).toContain('dirty')
    expect(byName('dirty')?.reasons).not.toContain('merged')
    expect(byName('local')?.blockers).toContain('unpushed')
    expect(byName('vanished')?.reasons).toEqual(['prunable'])
    expect(byName('busy')?.blockers).toContain('process-inside')
    expect(byName('busy')?.processes).toEqual([{ pid: 4242, name: 'proc-4242' }])
    expect(scan.worktrees.find((entry) => entry.path === repo)?.blockers).toContain('main-worktree')
    expect(scan.strayFolders.map((folder) => folder.path)).toEqual([stray])
    expect(scan.prunable).toEqual([{ repoId: 'repo-1', paths: [vanished] }])
  })

  it('does not call a branch that was never committed to merged', async () => {
    await addWorktree('fresh')
    await fx.commit(repo, 'main.txt', 'main moves on')
    await fx.git(repo, 'push', '-q', 'origin', 'main')
    await fx.git(repo, 'fetch', '-q', 'origin')
    const { byName } = await scanOne()
    expect(byName('fresh')?.reasons).not.toContain('merged')
  })

  it('marks old checkouts stale', async () => {
    const path = await addWorktree('old')
    const gitDir = join(repo, '.git', 'worktrees', 'old')
    const then = (Date.now() - TIDY_STALE_MS - 60_000) / 1000
    for (const file of ['index', 'HEAD', join('logs', 'HEAD')]) {
      utimesSync(join(gitDir, file), then, then)
    }
    expect(existsSync(path)).toBe(true)
    const { byName } = await scanOne()
    expect(byName('old')?.reasons).toContain('stale')
  })

  it('archives into the Trash through the runtime removal and restores every file', async () => {
    const path = await addWorktree('feature')
    await fx.commit(path, 'f.txt', 'feature work')
    await fx.git(path, 'push', '-q', '-u', 'origin', 'feature')
    writeFileSync(join(path, 'notes.local'), 'ignored-by-nobody\n')
    const head = (await fx.git(path, 'rev-parse', 'HEAD')).trim()
    const removeWorktree = vi.fn(orcaRemoval(path, 'feature'))
    const actions = actionsWith(removeWorktree)
    const worktreeId = `repo-1::${path}`

    await expect(applyOn(actions, { kind: 'archive', worktreeId })).rejects.toThrow(/dirty/)
    const archived = await applyOn(actions, { kind: 'archive', worktreeId }, ['dirty'])
    expect(removeWorktree).toHaveBeenCalledWith(worktreeId)
    expect(existsSync(path)).toBe(false)
    expect(existsSync(join(fx.home, '.Trash', 'feature', 'notes.local'))).toBe(true)
    expect(archived.undo?.kind).toBe('restore')

    const { scan } = await scanOne()
    const [record] = scan.archives
    expect((await fx.git(repo, 'rev-parse', record.ref)).trim()).toBe(head)
    await actions.run({ planId: scan.planId, action: { kind: 'restore', archiveId: record.id } })
    expect((await fx.git(path, 'rev-parse', 'HEAD')).trim()).toBe(head)
    expect((await fx.git(path, 'branch', '--show-current')).trim()).toBe('feature')
    expect(readFileSync(join(path, 'notes.local'), 'utf8')).toBe('ignored-by-nobody\n')
    // The folder itself came back: nothing of it is left in the Trash.
    expect(existsSync(join(fx.home, '.Trash', 'feature'))).toBe(false)
    expect(await fx.git(path, 'status', '--porcelain')).toBe('?? notes.local\n')
    await expect(fx.git(repo, 'rev-parse', '--verify', record.ref)).rejects.toThrow()
  })

  it('refuses an apply once the worktree changed since the scan', async () => {
    const path = await addWorktree('moving')
    await fx.commit(path, 'm.txt', 'first')
    await fx.git(path, 'push', '-q', '-u', 'origin', 'moving')
    const actions = actionsWith(orcaRemoval(path, 'moving'))
    const { scan } = await scanOne()
    await fx.commit(path, 'm2.txt', 'second')
    await fx.git(path, 'push', '-q')
    const archive = { kind: 'archive' as const, worktreeId: `repo-1::${path}` }
    await expect(actions.run({ planId: scan.planId, action: archive })).rejects.toThrow(
      /changed since you looked/
    )
    await expect(actions.run({ planId: 'not-a-plan', action: archive })).rejects.toThrow(/expired/)
    expect(existsSync(path)).toBe(true)
  })

  it('still calls a restored merged branch merged', async () => {
    const path = await addWorktree('shipped')
    await fx.commit(path, 's.txt', 'shipped work')
    await fx.git(path, 'push', '-q', 'origin', 'shipped:main')
    await fx.git(repo, 'fetch', '-q', 'origin')
    const actions = actionsWith(orcaRemoval(path, 'shipped'))
    await applyOn(actions, { kind: 'archive', worktreeId: `repo-1::${path}` })
    const { scan } = await scanOne()
    await actions.run({
      planId: scan.planId,
      action: { kind: 'restore', archiveId: scan.archives[0].id }
    })
    const { byName } = await scanOne()
    expect(byName('shipped')?.reasons).toContain('merged')
  })

  it('removes with git alone a worktree the runtime does not list yet', async () => {
    const path = await addWorktree('fresh-restore')
    await fx.commit(path, 'r.txt', 'work')
    const actions = actionsWith(async () => {
      throw new Error('selector_not_found')
    })
    await applyOn(actions, { kind: 'archive', worktreeId: `repo-1::${path}` }, ['unpushed'])
    expect(existsSync(path)).toBe(false)
    const { scan } = await scanOne()
    expect(scan.archives[0].ref).toMatch(/^refs\/pod\/archive\//)
    // The branch stays (only Orca's removal deletes it), so restore checks it out again.
    await actions.run({
      planId: scan.planId,
      action: { kind: 'restore', archiveId: scan.archives[0].id }
    })
    expect((await fx.git(path, 'branch', '--show-current')).trim()).toBe('fresh-restore')
  })

  it('puts everything back when the runtime refuses the removal', async () => {
    const path = await addWorktree('refused')
    const actions = actionsWith(async () => {
      throw new Error('worktree_busy')
    })
    await expect(
      applyOn(actions, { kind: 'archive', worktreeId: `repo-1::${path}` })
    ).rejects.toThrow('worktree_busy')
    expect(existsSync(join(path, 'README.md'))).toBe(true)
    expect(await fx.git(repo, 'for-each-ref', 'refs/pod/archive')).toBe('')
    expect((await createWorkspaceJournal(join(fx.root, 'journal.json')).read()).archives).toEqual(
      []
    )
  })

  it('needs a tick for a process inside, and never archives the main checkout', async () => {
    const path = await addWorktree('busy')
    cwds.set(77, path)
    const removeWorktree = vi.fn(orcaRemoval(path, 'busy'))
    const actions = actionsWith(removeWorktree)
    const worktreeId = `repo-1::${path}`
    await expect(applyOn(actions, { kind: 'archive', worktreeId })).rejects.toThrow(
      /process-inside/
    )
    await expect(
      applyOn(actions, { kind: 'archive', worktreeId: `repo-1::${repo}` }, ['dirty', 'unpushed'])
    ).rejects.toThrow(/main-worktree/)
    expect(removeWorktree).not.toHaveBeenCalled()
    await applyOn(actions, { kind: 'archive', worktreeId }, ['process-inside'])
    expect(removeWorktree).toHaveBeenCalledOnce()
  })

  it('prunes gone registrations, trashes proven strays and puts them back', async () => {
    const gone = await addWorktree('gone')
    rmSync(gone, { recursive: true, force: true })
    const stray = join(wtRoot, 'leftover')
    mkdirSync(stray)
    writeFileSync(join(stray, 'keep.txt'), 'mine\n')
    const old = (Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000
    utimesSync(stray, old, old)
    const actions = actionsWith(async () => {})

    const pruned = await applyOn(actions, { kind: 'prune', repoId: 'repo-1' })
    expect(pruned.pruned).toEqual(['gone'])
    expect(await fx.git(repo, 'worktree', 'list')).not.toContain('gone')

    const trashed = await applyOn(actions, { kind: 'trash-stray', repoId: 'repo-1', path: stray })
    expect(existsSync(stray)).toBe(false)
    expect(osTrash).not.toHaveBeenCalled()
    expect(trashed.undo?.kind).toBe('put-back')
    await expect(
      applyOn(actions, { kind: 'trash-stray', repoId: 'repo-1', path: repo })
    ).rejects.toThrow(/does not cover/)

    const { scan } = await scanOne()
    await actions.run({
      planId: scan.planId,
      action: { kind: 'put-back', trashedId: scan.trashed[0].id }
    })
    expect(readFileSync(join(stray, 'keep.txt'), 'utf8')).toBe('mine\n')
  })
})
