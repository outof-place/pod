import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createReftableRepoWithWorktree,
  GIT_SUPPORTS_REFTABLE,
  runGit
} from '../git/reftable-test-repo'
import { readRepoWorktreeAdminFingerprint } from './repo-worktree-admin-fingerprint'

describe.skipIf(!GIT_SUPPORTS_REFTABLE)(
  'readRepoWorktreeAdminFingerprint on reftable repos',
  () => {
    let root: string

    beforeEach(async () => {
      root = await realpath(await mkdtemp(join(tmpdir(), 'orca-reftable-fingerprint-')))
      const globalConfig = join(root, 'gitconfig')
      await writeFile(globalConfig, '')
      vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig)
      vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
    })

    afterEach(async () => {
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    })

    it('moves with a branch switch in a linked worktree and holds steady otherwise', async () => {
      const { repo, worktree } = createReftableRepoWithWorktree(root)
      runGit(worktree, ['branch', 'other'])
      const before = await readRepoWorktreeAdminFingerprint(repo)
      expect(before).not.toBeNull()
      expect(await readRepoWorktreeAdminFingerprint(repo)).toBe(before)
      runGit(worktree, ['symbolic-ref', 'HEAD', 'refs/heads/other'])
      expect(await readRepoWorktreeAdminFingerprint(repo)).not.toBe(before)
    })
  }
)
