// Fork-only (Pod): when a worktree's branch counts as merged into its base, by commits or content.
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { WorkspaceCleanupGitRoute } from '../../ipc/workspace-cleanup-git-route'
import { isWorkspaceCleanupBranchMerged } from '../../ipc/workspace-cleanup-merged'
import type { WorkspaceGitExec } from './workspace-git-exec'
import type { PorcelainWorktree } from './workspace-tidy-git'

const LOCAL_ROUTE: WorkspaceCleanupGitRoute = { kind: 'local', hostId: LOCAL_EXECUTION_HOST_ID }
const UNSUPPORTED_MERGE_TREE = /unknown option|usage: git merge-tree/i
/** git's well-known empty tree: no attributes, so no merge drivers. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
let mergeTreeUnsupported = false

/**
 * Orca's merged rule (#27020: ancestry, and a branch with a single reflog entry never counts),
 * plus Pod's: a branch restored from a Pod archive has one entry too, yet carried work.
 */
export async function isMerged(
  git: WorkspaceGitExec,
  entry: PorcelainWorktree,
  isMain: boolean,
  base: string | null
): Promise<boolean> {
  if (!entry.branch || !base) {
    return false
  }
  const checkout = {
    path: entry.path,
    branch: entry.branch,
    isMainWorktree: isMain,
    prunable: false
  }
  if (await isWorkspaceCleanupBranchMerged(checkout, base, LOCAL_ROUTE)) {
    return true
  }
  const short = entry.branch.replace(/^refs\/heads\//, '')
  if (isMain || base === short || base.endsWith(`/${short}`)) {
    return false
  }
  const reflog = await git(['reflog', 'show', '-n', '2', '--format=%gs', entry.branch], entry.path)
  const lines = reflog.stdout.split('\n').filter(Boolean)
  if (lines.length !== 1 || !lines[0].includes('refs/pod/archive/')) {
    return false
  }
  return (await git(['merge-base', '--is-ancestor', 'HEAD', base], entry.path)).code === 0
}

/**
 * A squash or rebase merge: the base has the branch's changes but not its commits. A
 * `merge-tree --write-tree` (Git 2.38+) that comes out clean and equal to the base's tree means
 * nothing of the branch is missing there. It touches no worktree; its objects land unreachable in
 * the repo, for gc. Attributes come from the empty tree (`--attr-source`, 2.40+) and the user's
 * attributes file is off, so neither the tree nor the user's config picks a merge driver for a
 * background scan; the repo's own `info/attributes` still applies, as git has no switch for it.
 * A branch with no commits of its own never counts (Orca's single-reflog rule, for a worktree
 * just created); one whose commits net to nothing does, and its commits stay in the archive ref.
 * Older git, a conflict, or a blob a blobless clone lacks all answer false.
 */
export async function isMergedByContent(
  git: WorkspaceGitExec,
  entry: PorcelainWorktree,
  isMain: boolean,
  base: string | null
): Promise<boolean> {
  const short = entry.branch?.replace(/^refs\/heads\//, '')
  if (!entry.branch || !base || isMain || base === short || base.endsWith(`/${short}`)) {
    return false
  }
  const range = `${base}..${entry.branch}`
  const own = await git(['rev-list', '--count', '--end-of-options', range], entry.path)
  if (own.code !== 0 || Number(own.stdout.trim()) === 0) {
    return false
  }
  if (mergeTreeUnsupported) {
    return false
  }
  const [merged, baseTree] = await Promise.all([
    git(
      [
        '-c',
        'core.attributesFile=/dev/null',
        `--attr-source=${EMPTY_TREE}`,
        'merge-tree',
        '--write-tree',
        '--no-messages',
        '--end-of-options',
        base,
        entry.branch
      ],
      entry.path
    ),
    git(['rev-parse', '--verify', '--quiet', `${base}^{tree}`], entry.path)
  ])
  // Git before 2.40 lacks --attr-source (before 2.38, --write-tree); it won't gain them while Pod runs.
  if (merged.code !== 0 && UNSUPPORTED_MERGE_TREE.test(merged.stderr)) {
    mergeTreeUnsupported = true
  }
  const tree = merged.stdout.split('\n')[0]?.trim() ?? ''
  return merged.code === 0 && baseTree.code === 0 && tree !== '' && tree === baseTree.stdout.trim()
}
