import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PodTidyWorktree } from '../../../shared/pod-workspace-tidy-types'
import { createWorkspaceGitExec } from './workspace-git-exec'
import { createWorkspaceJournal } from './workspace-journal'
import type { ProcessCwdReader } from './workspace-process-cwds'
import { createRealGitFixture, type RealGitFixture } from './workspace-real-git-test-fixture'
import { createWorkspaceTidyActions } from './workspace-tidy-actions'
import { scanWorkspaceTidy, TIDY_STALE_MS } from './workspace-tidy-scan'

describe('workspace tidy (real git)', () => {
  let fx: RealGitFixture
  let repo: string
  let wtRoot: string
  let cwds: Map<number, string>

  const processes: ProcessCwdReader = {
    listPids: () => [...cwds.keys()],
    readCwd: (pid) => cwds.get(pid) ?? null,
    readNames: async (pids) => new Map(pids.map((pid) => [pid, `proc-${pid}`]))
  }

  const deps = () => ({
    git: createWorkspaceGitExec(),
    processes,
    journal: createWorkspaceJournal(join(fx.root, 'journal.json')),
    defaultBaseRef: async () => 'origin/main'
  })

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
  })

  afterEach(() => fx.dispose())

  const scanOne = async () => {
    const scan = await scanWorkspaceTidy(deps(), [fx.repoRecord(repo)])
    const byName = (name: string): PodTidyWorktree | undefined =>
      scan.worktrees.find((entry) => entry.path === join(wtRoot, name))
    return { scan, byName }
  }

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
    expect(scan.prunable).toEqual([{ repoId: 'repo-1', names: [vanished] }])
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

  it('archives a clean worktree through the runtime removal and restores it', async () => {
    const path = await addWorktree('feature')
    await fx.commit(path, 'f.txt', 'feature work')
    const head = (await fx.git(path, 'rev-parse', 'HEAD')).trim()
    const removeWorktree = vi.fn(async () => {
      await fx.git(repo, 'worktree', 'remove', path)
      await fx.git(repo, 'branch', '-D', 'feature')
    })
    const trash = vi.fn(async () => {})
    const actions = createWorkspaceTidyActions({
      ...deps(),
      getRepo: () => fx.repoRecord(repo),
      removeWorktree,
      trash
    })
    const archived = await actions.run({ kind: 'archive', worktreeId: `repo-1::${path}` })
    expect(removeWorktree).toHaveBeenCalledWith(`repo-1::${path}`)
    expect(existsSync(path)).toBe(false)
    const ref = archived.archive?.ref ?? ''
    expect((await fx.git(repo, 'rev-parse', ref)).trim()).toBe(head)

    await actions.run({ kind: 'restore', archiveId: archived.archive?.id ?? '' })
    expect((await fx.git(path, 'rev-parse', 'HEAD')).trim()).toBe(head)
    expect((await fx.git(path, 'branch', '--show-current')).trim()).toBe('feature')
    await expect(fx.git(repo, 'rev-parse', '--verify', ref)).rejects.toThrow()
  })

  it('still calls a restored merged branch merged', async () => {
    const path = await addWorktree('shipped')
    await fx.commit(path, 's.txt', 'shipped work')
    await fx.git(path, 'push', '-q', 'origin', 'shipped:main')
    await fx.git(repo, 'fetch', '-q', 'origin')
    const actions = createWorkspaceTidyActions({
      ...deps(),
      getRepo: () => fx.repoRecord(repo),
      removeWorktree: async () => {
        await fx.git(repo, 'worktree', 'remove', path)
        await fx.git(repo, 'branch', '-D', 'shipped')
      },
      trash: async () => {}
    })
    const archived = await actions.run({ kind: 'archive', worktreeId: `repo-1::${path}` })
    await actions.run({ kind: 'restore', archiveId: archived.archive?.id ?? '' })
    const { byName } = await scanOne()
    expect(byName('shipped')?.reasons).toContain('merged')
  })

  it('removes with git alone a worktree the runtime does not list yet', async () => {
    const path = await addWorktree('fresh-restore')
    await fx.commit(path, 'r.txt', 'work')
    const actions = createWorkspaceTidyActions({
      ...deps(),
      getRepo: () => fx.repoRecord(repo),
      removeWorktree: async () => {
        throw new Error('selector_not_found')
      },
      trash: async () => {}
    })
    const archived = await actions.run({ kind: 'archive', worktreeId: `repo-1::${path}` })
    expect(existsSync(path)).toBe(false)
    expect(archived.archive?.ref).toMatch(/^refs\/pod\/archive\//)
    // The branch stays (only Orca's removal deletes it), so restore checks it out again.
    await actions.run({ kind: 'restore', archiveId: archived.archive?.id ?? '' })
    expect((await fx.git(path, 'branch', '--show-current')).trim()).toBe('fresh-restore')
  })

  it('keeps no archive when the runtime refuses the removal', async () => {
    const path = await addWorktree('refused')
    const actions = createWorkspaceTidyActions({
      ...deps(),
      getRepo: () => fx.repoRecord(repo),
      removeWorktree: async () => {
        throw new Error('worktree_busy')
      },
      trash: async () => {}
    })
    await expect(actions.run({ kind: 'archive', worktreeId: `repo-1::${path}` })).rejects.toThrow(
      'worktree_busy'
    )
    expect(existsSync(path)).toBe(true)
    expect(await fx.git(repo, 'for-each-ref', 'refs/pod/archive')).toBe('')
    expect((await createWorkspaceJournal(join(fx.root, 'journal.json')).read()).archives).toEqual(
      []
    )
  })

  it('refuses to archive a dirty worktree or one a process is in', async () => {
    const path = await addWorktree('wip')
    writeFileSync(join(path, 'note.txt'), 'unsaved\n')
    const removeWorktree = vi.fn(async () => {})
    const actions = createWorkspaceTidyActions({
      ...deps(),
      getRepo: () => fx.repoRecord(repo),
      removeWorktree,
      trash: async () => {}
    })
    await expect(actions.run({ kind: 'archive', worktreeId: `repo-1::${path}` })).rejects.toThrow(
      /dirty/
    )
    expect(removeWorktree).not.toHaveBeenCalled()
  })

  it('prunes registrations of deleted folders and trashes only proven stray folders', async () => {
    const gone = await addWorktree('gone')
    rmSync(gone, { recursive: true, force: true })
    const stray = join(wtRoot, 'leftover')
    mkdirSync(stray)
    const old = (Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000
    utimesSync(stray, old, old)
    const trash = vi.fn(async () => {})
    const actions = createWorkspaceTidyActions({
      ...deps(),
      getRepo: () => fx.repoRecord(repo),
      removeWorktree: async () => {},
      trash
    })
    const pruned = await actions.run({ kind: 'prune', repoId: 'repo-1' })
    expect(pruned.pruned).toEqual(['gone'])
    expect(await fx.git(repo, 'worktree', 'list')).not.toContain('gone')

    await actions.run({ kind: 'trash-stray', repoId: 'repo-1', path: stray })
    expect(trash).toHaveBeenCalledWith(stray)
    await expect(
      actions.run({ kind: 'trash-stray', repoId: 'repo-1', path: repo })
    ).rejects.toThrow(/no longer a stray/)
  })
})
