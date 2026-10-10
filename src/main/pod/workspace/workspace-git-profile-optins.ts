import {
  POD_BACKFILL_BYTES_PER_BLOB,
  POD_OPT_IN_KEYS,
  type PodGitProfileRow
} from '../../../shared/pod-workspace-git-profile'
import type { PodProfileOptIn, PodProfileOptInId } from '../../../shared/pod-workspace-tidy-types'
import { gitStreamStdout } from '../../git/runner'
import type { GitHostFacts, RepoProfileFacts } from './workspace-git-profile-facts'
import type { WorkspaceGitExec } from './workspace-git-exec'

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

/** Off by default: none measured a win worth a default, and each has a cost the user should see. */
export function planOptIns(
  host: GitHostFacts,
  facts: RepoProfileFacts,
  rows: readonly PodGitProfileRow[],
  count: Count | null
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
    backfillOptIn(host, facts, count)
  ]
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
