import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  classifyWorktreeBaseChange,
  type WorktreeBaseWatchTarget
} from './worktree-base-directory-event-filter'
import {
  EMPTY_HEAD_IDENTITY_SCOPE,
  FULL_HEAD_IDENTITY_SCOPE,
  headIdentityScopeForEntry
} from './worktree-head-identity-scope'

const COMMON_DIR = join('/repos', 'project', '.git')
const TARGET: WorktreeBaseWatchTarget = {
  key: `git-common:local:${COMMON_DIR}`,
  kind: 'git-common',
  path: COMMON_DIR,
  repos: new Map([['repo-1', { repoId: 'repo-1', repoName: 'project', nestWorkspaces: false }]])
}

function classify(...parts: string[]): ReturnType<typeof classifyWorktreeBaseChange> {
  return classifyWorktreeBaseChange(TARGET, { type: 'update', path: join(COMMON_DIR, ...parts) })
}

describe('classifyWorktreeBaseChange (reftable stacks)', () => {
  it('re-reads every head when the shared stack moves', () => {
    expect(classify('reftable', 'tables.list')).toEqual({
      structureRepoIds: [],
      gitStatusRepoIds: [],
      headIdentityRepoIds: ['repo-1'],
      headIdentityScope: FULL_HEAD_IDENTITY_SCOPE
    })
  })

  it('re-reads only the entry whose own stack moved', () => {
    expect(classify('worktrees', 'wt-a', 'reftable', 'tables.list')).toEqual({
      structureRepoIds: [],
      gitStatusRepoIds: [],
      headIdentityRepoIds: ['repo-1'],
      headIdentityScope: headIdentityScopeForEntry('wt-a')
    })
  })

  it('ignores table files, lock files and the stack dirs themselves', () => {
    const noChange = {
      structureRepoIds: [],
      gitStatusRepoIds: [],
      headIdentityRepoIds: [],
      headIdentityScope: EMPTY_HEAD_IDENTITY_SCOPE
    }
    expect(classify('reftable', '0x000000000001-0x000000000002-0a1b2c3d.ref')).toEqual(noChange)
    expect(classify('reftable', 'tables.list.lock')).toEqual(noChange)
    expect(classify('worktrees', 'wt-a', 'reftable', 'tables.list.lock')).toEqual(noChange)
    expect(classify('worktrees', 'wt-a', 'reftable')).toEqual(noChange)
  })
})
