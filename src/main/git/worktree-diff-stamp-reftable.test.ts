import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReftableRepoWithWorktree, GIT_SUPPORTS_REFTABLE, runGit } from './reftable-test-repo'
import { readWorktreeDiffStamp } from './source-control/worktree-diff-stamp'

describe.skipIf(!GIT_SUPPORTS_REFTABLE)('readWorktreeDiffStamp on reftable repos', () => {
  let root: string

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'orca-reftable-stamp-')))
    const globalConfig = join(root, 'gitconfig')
    await writeFile(globalConfig, '')
    vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig)
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  })

  it("changes when a linked worktree's HEAD moves without an index write", async () => {
    const { repo, worktree } = createReftableRepoWithWorktree(root)
    runGit(repo, ['commit', '--quiet', '--allow-empty', '-m', 'two'])
    const before = await readWorktreeDiffStamp(worktree, 'file.txt', true)
    expect((await readWorktreeDiffStamp(worktree, 'file.txt', true))?.value).toBe(before?.value)
    runGit(worktree, ['update-ref', '--no-deref', 'HEAD', runGit(repo, ['rev-parse', 'main'])])
    const after = await readWorktreeDiffStamp(worktree, 'file.txt', true)
    expect(after?.value).toBeDefined()
    expect(after?.value).not.toBe(before?.value)
  })

  it('changes when a commit moves the primary checkout', async () => {
    const { repo } = createReftableRepoWithWorktree(root)
    const before = await readWorktreeDiffStamp(repo, 'file.txt', false)
    runGit(repo, ['commit', '--quiet', '--allow-empty', '-m', 'two'])
    expect((await readWorktreeDiffStamp(repo, 'file.txt', false))?.value).not.toBe(before?.value)
  })
})
