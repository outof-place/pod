import {
  POD_BACKFILL_BYTES_PER_BLOB,
  POD_OPT_IN_KEYS,
  type PodGitProfileCurrent,
  type PodGitProfileRow
} from '../../../shared/pod-workspace-git-profile'
import type { PodProfileOptIn, PodProfileOptInId } from '../../../shared/pod-workspace-tidy-types'
import { gitStreamStdout } from '../../git/runner'
import type { GitHostFacts, RepoProfileFacts } from './workspace-git-profile-facts'
import type { WorkspaceGitExec } from './workspace-git-exec'
import { parseWorktreePorcelainZ } from './workspace-tidy-git'

// Why: counting walks every object in HEAD's history; never on a path the UI waits on.
const COUNT_TIMEOUT_MS = 180_000
const COUNT_MAX_BYTES = 1024 * 1024 * 1024
const BACKFILL_TIMEOUT_MS = 2 * 60 * 60 * 1000

type Count = { state: 'counting' } | { state: 'ready'; missingBlobs: number } | { state: 'failed' }

/**
 * Blobs a blobless clone lacks in HEAD's history, which `git backfill` would download.
 * Counted in the background, with lazy fetches off, and cached per repo and HEAD.
 */
export function createBackfillEstimator() {
  const counts = new Map<string, Count>()

  const count = async (repoPath: string): Promise<number> => {
    let missing = 0
    let carry = ''
    await gitStreamStdout(['rev-list', '--objects', '--missing=print', 'HEAD'], {
      cwd: repoPath,
      env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
      timeoutMs: COUNT_TIMEOUT_MS,
      maxBuffer: COUNT_MAX_BYTES,
      admissionTier: 'background',
      onStdout: (chunk) => {
        const lines = (carry + chunk).split('\n')
        carry = lines.pop() ?? ''
        for (const line of lines) {
          if (line.startsWith('?')) {
            missing += 1
          }
        }
      }
    })
    return carry.startsWith('?') ? missing + 1 : missing
  }

  return (facts: RepoProfileFacts, repoPath: string): Count | null => {
    if (!facts.partialClone || facts.head === null) {
      return null
    }
    const key = `${facts.commonDir}\0${facts.head}`
    const known = counts.get(key)
    if (known) {
      return known
    }
    counts.set(key, { state: 'counting' })
    void count(repoPath).then(
      (missingBlobs) => counts.set(key, { state: 'ready', missingBlobs }),
      () => counts.set(key, { state: 'failed' })
    )
    return { state: 'counting' }
  }
}

export type BackfillEstimator = ReturnType<typeof createBackfillEstimator>

function megabytes(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1_000_000))} MB`
}

function backfillOptIn(
  host: GitHostFacts,
  facts: RepoProfileFacts,
  count: Count | null
): PodProfileOptIn {
  const base = { id: 'backfill' as const, active: false }
  if (!facts.partialClone) {
    return { ...base, available: false, note: 'Only for blobless clones; this one has every file.' }
  }
  if (!host.backfill) {
    return { ...base, available: false, note: 'Needs git 2.49 or newer.' }
  }
  if (count?.state === 'ready') {
    const bytes = count.missingBlobs * POD_BACKFILL_BYTES_PER_BLOB
    return count.missingBlobs === 0
      ? { ...base, available: false, active: true, note: 'Every file in this history is here.' }
      : {
          ...base,
          available: true,
          note: `Downloads about ${megabytes(bytes)} once, so history searches stop fetching file by file.`,
          estimate: { missingBlobs: count.missingBlobs, bytes }
        }
  }
  return {
    ...base,
    available: true,
    note:
      count?.state === 'failed'
        ? 'Could not count what it would download.'
        : 'Counting what it would download…'
  }
}

function relativeWorktreesOptIn(
  host: GitHostFacts,
  row: PodGitProfileCurrent[string] | undefined
): PodProfileOptIn {
  const base = { id: 'relative-worktrees' as const }
  if (row?.local === 'true') {
    return {
      ...base,
      available: false,
      active: true,
      note: 'Worktrees already link by relative path.'
    }
  }
  if (row && (row.other || (row.local !== null && row.recorded !== row.local))) {
    return { ...base, available: false, active: false, note: 'Set by you.' }
  }
  return host.relativeWorktrees
    ? {
        ...base,
        available: true,
        active: false,
        note: 'The repo and its worktrees can move together with nothing to repair. git turns on a repository extension: git older than 2.48 and tools built on libgit2 can no longer open this repository at all, main checkout included.'
      }
    : { ...base, available: false, active: false, note: 'Needs git 2.48 or newer.' }
}

/** Off by default: none measured a win worth a default, and each has a cost the user should see. */
export function planOptIns(
  host: GitHostFacts,
  facts: RepoProfileFacts,
  rows: readonly PodGitProfileRow[],
  count: Count | null,
  relative?: PodGitProfileCurrent[string]
): PodProfileOptIn[] {
  const keyRow = (id: 'many-files' | 'bitmaps') =>
    rows.find((row) => row.key === POD_OPT_IN_KEYS[id])
  const keyActive = (id: 'many-files' | 'bitmaps') => keyRow(id)?.action === 'keep'
  const keyTaken = (id: 'many-files' | 'bitmaps') => keyRow(id)?.action === 'user'
  const reftable: PodProfileOptIn =
    facts.refFormat === 'reftable'
      ? { id: 'reftable', available: false, active: true, note: 'Already uses reftable.' }
      : !host.refsMigrate
        ? { id: 'reftable', available: false, active: false, note: 'Needs git 2.46 or newer.' }
        : facts.linkedWorktrees > 0
          ? {
              id: 'reftable',
              available: false,
              active: false,
              note: 'git converts only a repository without linked worktrees.'
            }
          : {
              id: 'reftable',
              available: true,
              active: false,
              // Measured: 10k ref writes 1405 → 134 ms, ref reads 10–33% faster.
              note: 'Faster ref writes and reads; git older than 2.45 can no longer open it.'
            }
  return [
    reftable,
    {
      id: 'many-files',
      available: !keyTaken('many-files'),
      active: keyActive('many-files'),
      // Measured: status +3% on top of Orca's untracked cache and index v4.
      note: keyTaken('many-files') ? 'Set by you.' : 'No win measured over the defaults.'
    },
    {
      id: 'bitmaps',
      available: !facts.partialClone && !keyTaken('bitmaps'),
      active: keyActive('bitmaps'),
      note: facts.partialClone
        ? 'git cannot write bitmaps in a blobless clone.'
        : 'Helps serving clones from this repo; no local win measured.'
    },
    backfillOptIn(host, facts, count),
    relativeWorktreesOptIn(host, relative)
  ]
}

const RELATIVE_KEY = 'worktree.useRelativePaths'

/**
 * Each linked worktree's path, for `worktree repair`: without them git 2.54 rewrites no link on
 * `--no-relative-paths`, so undo would leave every worktree relative. A list git refuses throws:
 * a repair without it would change nothing and still pass.
 */
async function linkedWorktrees(git: WorkspaceGitExec, repoPath: string): Promise<string[]> {
  const list = await git(['worktree', 'list', '--porcelain', '-z'], repoPath)
  if (list.code !== 0) {
    throw new Error(list.stderr.trim() || 'git worktree list failed')
  }
  return parseWorktreePorcelainZ(list.stdout)
    .slice(1)
    .map((entry) => entry.path)
}

const RELATIVE_EXTENSION = 'extensions.relativeWorktrees'
const FORMAT_VERSION = 'core.repositoryformatversion'

async function localValue(git: WorkspaceGitExec, repoPath: string, key: string) {
  const result = await git(['config', '--local', '--get', key], repoPath)
  return result.code === 0 ? result.stdout.trim() : null
}

export type RelativeWorktreesBefore = { extension: string | null; formatVersion: string | null }

/** What relative-worktrees will change, read before it changes anything, for undo. */
export async function readRelativeWorktreesBefore(
  git: WorkspaceGitExec,
  repoPath: string
): Promise<RelativeWorktreesBefore> {
  return {
    extension: await localValue(git, repoPath, RELATIVE_EXTENSION),
    formatVersion: await localValue(git, repoPath, FORMAT_VERSION)
  }
}

/**
 * Sets the key through Pod's recorded writer, then has git rewrite every link; git turns on the
 * repository extension (format version 1) itself. The caller records `before` first, so even a
 * repair that fails part way can be undone.
 */
export async function enableRelativeWorktrees(
  git: WorkspaceGitExec,
  setKey: (repoPath: string, key: string, value: string) => Promise<void>,
  repoPath: string
): Promise<void> {
  await setKey(repoPath, RELATIVE_KEY, 'true')
  const linked = await linkedWorktrees(git, repoPath)
  const repair = await git(['worktree', 'repair', '--relative-paths', ...linked], repoPath)
  if (repair.code !== 0) {
    throw new Error(repair.stderr.trim() || 'git worktree repair --relative-paths failed')
  }
}

async function restoreLocal(
  git: WorkspaceGitExec,
  repoPath: string,
  key: string,
  value: string | null
): Promise<void> {
  await git(['config', '--local', ...(value === null ? ['--unset', key] : [key, value])], repoPath)
}

/** Absolute links again; the extension and the format version go back to what Pod found. */
export async function disableRelativeWorktrees(
  git: WorkspaceGitExec,
  repoPath: string,
  before: RelativeWorktreesBefore
): Promise<void> {
  const linked = await linkedWorktrees(git, repoPath)
  const repair = await git(['worktree', 'repair', '--no-relative-paths', ...linked], repoPath)
  if (repair.code !== 0) {
    throw new Error(repair.stderr.trim() || 'git worktree repair --no-relative-paths failed')
  }
  await restoreLocal(git, repoPath, RELATIVE_EXTENSION, before.extension)
  const extensions = await git(['config', '--local', '--get-regexp', '^extensions\\.'], repoPath)
  // Format 1 is only for extensions; with none left an older git reads the repo again. With some
  // left (one the user turned on), version 1 must stay.
  if (extensions.code !== 0) {
    await restoreLocal(git, repoPath, FORMAT_VERSION, before.formatVersion)
  }
}

/** Converts the ref store in place; git refuses while another process holds a ref lock. */
export async function migrateRefFormat(
  git: WorkspaceGitExec,
  repoPath: string,
  format: 'reftable' | 'files'
): Promise<void> {
  const result = await git(['refs', 'migrate', `--ref-format=${format}`], repoPath, {
    timeoutMs: 120_000
  })
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `git refs migrate to ${format} failed`)
  }
}

/** Runs once in the background; its download is the point, so nothing undoes it. */
export function startBackfill(
  git: WorkspaceGitExec,
  repoPath: string,
  onDone: (error: string | null) => void
): void {
  void git(['backfill'], repoPath, { timeoutMs: BACKFILL_TIMEOUT_MS, lazyFetch: true }).then(
    (result) => onDone(result.code === 0 ? null : result.stderr.trim() || 'git backfill failed'),
    (error: unknown) => onDone(error instanceof Error ? error.message : String(error))
  )
}

export function isKeyOptIn(id: PodProfileOptInId): id is 'many-files' | 'bitmaps' {
  return id === 'many-files' || id === 'bitmaps'
}
