import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeHeadIdentity } from '../../shared/worktree/types'
import {
  createReftableRepoWithWorktree,
  GIT_SUPPORTS_REFTABLE,
  runGit
} from '../git/reftable-test-repo'
import {
  createWorktreeHeadIdentityCache,
  readGitCommonHeadIdentities
} from './worktree-head-identity-reader'
import { headIdentityScopeForEntry } from './worktree-head-identity-scope'

// What `git worktree list` reports, in the reader's row shape.
function gitWorktreeRows(repo: string): WorktreeHeadIdentity[] {
  return runGit(repo, ['worktree', 'list', '--porcelain'])
    .split('\n\n')
    .flatMap((block) => {
      const fields = new Map(
        block.split('\n').map((line) => [line.split(' ')[0], line.slice(line.indexOf(' ') + 1)])
      )
      const head = fields.get('HEAD')
      const worktreePath = fields.get('worktree')
      if (!head || !worktreePath || /^0+$/.test(head)) {
        return []
      }
      return [{ worktreePath, head, branch: fields.get('branch') ?? null }]
    })
}

describe.skipIf(!GIT_SUPPORTS_REFTABLE)('readGitCommonHeadIdentities on reftable repos', () => {
  let root: string

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'orca-reftable-heads-')))
    const globalConfig = join(root, 'gitconfig')
    await writeFile(globalConfig, '')
    vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig)
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  })

  it('matches git worktree list through commits, branch switches and detaching', async () => {
    const { repo, worktree, commonDir } = createReftableRepoWithWorktree(root)
    runGit(worktree, ['commit', '--quiet', '--allow-empty', '-m', 'two'])
    expect(await readGitCommonHeadIdentities(commonDir)).toEqual({
      identities: gitWorktreeRows(repo),
      complete: true
    })

    runGit(worktree, ['switch', '--quiet', '-c', 'topic'])
    runGit(worktree, ['commit', '--quiet', '--allow-empty', '-m', 'three'])
    runGit(repo, ['switch', '--quiet', '-c', 'side'])
    const switched = await readGitCommonHeadIdentities(commonDir)
    expect(switched.identities.map((row) => row.branch)).toEqual([
      'refs/heads/side',
      'refs/heads/topic'
    ])
    expect(switched.identities).toEqual(gitWorktreeRows(repo))

    runGit(worktree, ['switch', '--quiet', '--detach', 'main'])
    const detached = await readGitCommonHeadIdentities(commonDir)
    expect(detached.identities[1]).toEqual({
      worktreePath: worktree,
      head: runGit(repo, ['rev-parse', 'main']),
      branch: null
    })
  })

  it('reads SHA-256 repos', async () => {
    const { repo, commonDir } = createReftableRepoWithWorktree(root, 'sha256')
    const read = await readGitCommonHeadIdentities(commonDir)
    expect(read.identities).toEqual(gitWorktreeRows(repo))
    expect(read.identities[0].head).toHaveLength(64)
  })

  it('leaves an unborn branch to the structural listing', async () => {
    const { worktree, commonDir } = createReftableRepoWithWorktree(root)
    runGit(worktree, ['switch', '--quiet', '--orphan', 'fresh'])
    const read = await readGitCommonHeadIdentities(commonDir)
    expect(read).toEqual({
      identities: [expect.objectContaining({ branch: 'refs/heads/main' })],
      complete: true
    })
  })

  it('refreshes one entry from a scoped pass after its HEAD moves', async () => {
    const { repo, worktree, commonDir } = createReftableRepoWithWorktree(root)
    const cache = createWorktreeHeadIdentityCache()
    await readGitCommonHeadIdentities(commonDir, cache)
    runGit(worktree, ['switch', '--quiet', '-c', 'scoped'])
    runGit(worktree, ['commit', '--quiet', '--allow-empty', '-m', 'scoped'])
    const read = await readGitCommonHeadIdentities(
      commonDir,
      cache,
      headIdentityScopeForEntry('wt')
    )
    expect(read.identities).toEqual(gitWorktreeRows(repo))
    expect(read.identities[1].branch).toBe('refs/heads/scoped')
  })
})
