import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createReftableRepoWithWorktree,
  GIT_SUPPORTS_REFTABLE,
  runGit
} from '../git/reftable-test-repo'
import {
  gitCommonDirectorySignature,
  snapshotGitCommonEntry,
  type GitCommonEntrySnapshot
} from './worktree-git-common-entry-snapshot'
import { diffGitCommon, type GitCommonSnapshot } from './worktree-git-common-snapshot-diff'
import { PRIMARY_CHECKOUT_METADATA_FILES } from './worktree-git-common-metadata-files'
import { startShallowWatcher } from './parcel-watcher-shallow-subscription'

function commonSnapshot(entries: Map<string, GitCommonEntrySnapshot>): GitCommonSnapshot {
  return {
    worktreesDirSignature: 'missing',
    worktreesDirIdentity: null,
    entries,
    primarySignatures: new Map(),
    statusRefPaths: new Set(),
    statusRefSignatures: new Map(),
    didFullScan: false
  }
}

describe('linked-entry polling of reftable stacks', () => {
  let root: string

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'orca-reftable-poll-')))
    const globalConfig = join(root, 'gitconfig')
    await writeFile(globalConfig, '')
    vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig)
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  })

  it.skipIf(!GIT_SUPPORTS_REFTABLE)(
    "reports a HEAD move that only rewrote the entry's own stack",
    async () => {
      const { commonDir, entryDir, worktree } = createReftableRepoWithWorktree(root)
      runGit(worktree, ['branch', 'other'])
      const before = await snapshotGitCommonEntry(entryDir, undefined, false)
      const entryDirBefore = await gitCommonDirectorySignature(entryDir)
      runGit(worktree, ['symbolic-ref', 'HEAD', 'refs/heads/other'])
      // The entry dir gate alone would miss this write.
      expect(await gitCommonDirectorySignature(entryDir)).toBe(entryDirBefore)
      const after = await snapshotGitCommonEntry(entryDir, before, false)
      expect(after).not.toBe(before)
      expect(
        diffGitCommon(
          commonDir,
          commonSnapshot(new Map([[entryDir, before]])),
          commonSnapshot(new Map([[entryDir, after]]))
        )
      ).toEqual([{ type: 'update', path: join(entryDir, 'reftable', 'tables.list') }])
    }
  )

  it.skipIf(!GIT_SUPPORTS_REFTABLE)(
    'hears a primary branch switch through the shared stack list',
    async () => {
      const { repo, commonDir } = createReftableRepoWithWorktree(root)
      const paths: string[] = []
      const watcher = startShallowWatcher(
        commonDir,
        PRIMARY_CHECKOUT_METADATA_FILES,
        (events) => paths.push(...events.map((event) => event.path)),
        (error) => {
          throw error
        }
      )
      try {
        runGit(repo, ['switch', '--quiet', '-c', 'side'])
        await vi.waitFor(() => expect(paths).toContain(join(commonDir, 'reftable', 'tables.list')))
      } finally {
        await watcher.unsubscribe()
      }
    }
  )

  it('keeps a files-backend entry on the dir-signature gate', async () => {
    const entryDir = join(root, 'worktrees', 'wt')
    await mkdir(entryDir, { recursive: true })
    await writeFile(join(entryDir, 'HEAD'), 'ref: refs/heads/main\n')
    const first = await snapshotGitCommonEntry(entryDir, undefined, false)
    expect(first.reftableSignature).toBeNull()
    expect(await snapshotGitCommonEntry(entryDir, first, false)).toBe(first)
  })
})
