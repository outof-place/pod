import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createWorkspaceGitExec } from './workspace-git-exec'
import { createWorkspaceJournal } from './workspace-journal'
import { createWorkspacePlanStore } from './workspace-plan-store'
import { createRealGitFixture, type RealGitFixture } from './workspace-real-git-test-fixture'
import { scanWorkspaceTidy } from './workspace-tidy-scan'

describe('workspace tidy: squash-merged branches (real git)', () => {
  let fx: RealGitFixture
  let repo: string
  let wtRoot: string

  beforeEach(async () => {
    fx = await createRealGitFixture('pod-ws-squash-')
    ;({ repo } = await fx.cloneWithOrigin('app'))
    wtRoot = `${repo}.worktrees`
    mkdirSync(wtRoot)
  })

  afterEach(() => fx.dispose())

  const addWorktree = async (name: string) => {
    const path = join(wtRoot, name)
    await fx.git(repo, 'worktree', 'add', '-q', '-b', name, path, 'origin/main')
    return path
  }

  /** What a hosted squash merge leaves: one new commit on main with the branch's changes. */
  const squashIntoMain = async (branch: string) => {
    await fx.git(repo, 'merge', '-q', '--squash', branch)
    await fx.git(repo, 'commit', '-q', '-m', `squash ${branch}`)
    await fx.git(repo, 'push', '-q', 'origin', 'main')
    await fx.git(repo, 'fetch', '-q', '--prune', 'origin')
  }

  const scan = async () => {
    const result = await scanWorkspaceTidy(
      {
        git: createWorkspaceGitExec(),
        processes: null,
        journal: createWorkspaceJournal(join(fx.root, 'journal.json')),
        plans: createWorkspacePlanStore(),
        store: fx.store([fx.repoRecord(repo)])
      },
      [fx.repoRecord(repo)]
    )
    return (name: string) => result.worktrees.find((entry) => entry.path === join(wtRoot, name))
  }

  it('calls a squash-merged branch merged by content, and not unpushed', async () => {
    const path = await addWorktree('squashed')
    await fx.commit(path, 'a.txt', 'first')
    await fx.commit(path, 'b.txt', 'second')
    await fx.git(path, 'push', '-q', '-u', 'origin', 'squashed')
    await squashIntoMain('squashed')
    // The host deletes the branch after merging it.
    await fx.git(repo, 'push', '-q', 'origin', '--delete', 'squashed')
    await fx.git(repo, 'fetch', '-q', '--prune', 'origin')
    const worktree = (await scan())('squashed')
    expect(worktree?.reasons).toEqual(expect.arrayContaining(['squash-merged', 'upstream-gone']))
    expect(worktree?.reasons).not.toContain('merged')
    expect(worktree?.blockers).toEqual([])
  })

  it('keeps a branch with work the base lacks unpushed, and a fresh one unmerged', async () => {
    const partial = await addWorktree('partial')
    await fx.commit(partial, 'a.txt', 'landed')
    await squashIntoMain('partial')
    // Work after the squash: the base has the first change only.
    writeFileSync(join(partial, 'later.txt'), 'later\n')
    await fx.git(partial, 'add', 'later.txt')
    await fx.git(partial, 'commit', '-q', '-m', 'not landed')
    await addWorktree('fresh')
    const byName = await scan()
    expect(byName('partial')?.reasons).not.toContain('squash-merged')
    expect(byName('partial')?.blockers).toContain('unpushed')
    expect(byName('fresh')?.reasons).not.toContain('squash-merged')
  })
})
