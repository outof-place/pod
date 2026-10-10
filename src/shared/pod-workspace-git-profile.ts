// Fork-only (Pod): the git config Pod sets in the repositories it manages, on top of Orca's
// recommended tuning (#27028). Measured on a 35k-file blobless repo (git 2.56, M4 Max).

/** Multi-valued `<key>=<value>` record of what Pod wrote, so an undo removes exactly that. */
export const POD_GIT_PROFILE_RECORD_KEY = 'pod.workspaceConfig'

/**
 * From here Pod opts into Orca's file watcher: status 808 → 135 M instructions on 35k files;
 * below it a daemon (~5 MiB) buys a few ms. Orca's own index v4 floor is the same count.
 */
export const POD_GIT_PROFILE_LARGE_REPO_FILES = 10_000

/** Pack count above which Pod repacks hourly rather than daily (lazy-fetch churn). */
export const POD_GIT_PROFILE_MANY_PACKS = 50

/** Bytes per missing blob a backfill downloads, measured on this repo's history (8.7–8.9 KB). */
export const POD_BACKFILL_BYTES_PER_BLOB = 8_800

/** Pod's own keys; Orca's (#27028) come from its planner. Opt-ins are off unless ticked. */
export type PodGitProfileKey =
  | 'checkout.thresholdForParallelism'
  | 'maintenance.strategy'
  | 'maintenance.prefetch.enabled'
  | 'maintenance.geometric-repack.schedule'
  | 'feature.manyFiles'
  | 'repack.writeBitmaps'

export const POD_OPT_IN_KEYS: Readonly<Record<'many-files' | 'bitmaps', PodGitProfileKey>> = {
  'many-files': 'feature.manyFiles',
  bitmaps: 'repack.writeBitmaps'
}

export type PodGitProfileFacts = {
  gitVersion: readonly [number, number, number] | null
  trackedFiles: number | null
  packCount: number | null
  partialClone: boolean
  /** `git help --config` lists `maintenance.geometric-repack.auto`. */
  geometricMaintenance: boolean
}

/**
 * Per key, what the repository already has: `local` is the repo-local value, `other` is true
 * when any scope (global, system, include, worktree) sets the key outside Pod's own record.
 */
export type PodGitProfileCurrent = Record<
  string,
  { local: string | null; other: boolean; recorded: string | null }
>

export type PodGitProfileAction = 'set' | 'keep' | 'user' | 'skip' | 'opt-in'

export type PodGitProfileRow = {
  key: string
  value: string
  action: PodGitProfileAction
  /** Pod's reason, or Orca's skip reason for its keys. */
  reason: string
  /** What the repository has now; null when unset. */
  current: string | null
  /** `orca`: #27028's key, recorded in `orca.performanceConfig`; `pod`: Pod's own. */
  source: 'orca' | 'pod'
}

type Wanted = { key: PodGitProfileKey; value: string; reason: string | null; skip: string }

function atLeast(version: PodGitProfileFacts['gitVersion'], major: number, minor: number): boolean {
  return version !== null && (version[0] > major || (version[0] === major && version[1] >= minor))
}

function wantedKeys(facts: PodGitProfileFacts): Wanted[] {
  const churn = facts.partialClone || (facts.packCount ?? 0) > POD_GIT_PROFILE_MANY_PACKS
  const geometric = facts.geometricMaintenance ? 'measured' : null
  return [
    {
      // Why: workers=0 took worktree add 3.8 → 2.4 s but a 785-file branch switch 0.7 → 1.3 s;
      // at 4000 the add stays parallel (2.1 s) and the switch sequential (0.6 s).
      key: 'checkout.thresholdForParallelism',
      value: '4000',
      reason: atLeast(facts.gitVersion, 2, 32) ? 'measured' : null,
      skip: 'git-too-old'
    },
    // Why geometric: 3754 packs cost every git command +32 ms; one repack took cat-file 46 → 12 ms,
    // ahead/behind 144 → 12 ms. The incremental strategy's MIDX repack left the packs (3754 → 3811).
    {
      key: 'maintenance.strategy',
      value: 'geometric',
      reason: geometric,
      skip: 'no-geometric-maintenance'
    },
    // Why: Pod fetches on its own; an hourly background fetch per repo costs a metered link.
    {
      key: 'maintenance.prefetch.enabled',
      value: 'false',
      reason: geometric,
      skip: 'no-geometric-maintenance'
    },
    {
      // Why: a blobless clone gains a pack per lazy fetch (50–90 a minute measured).
      key: 'maintenance.geometric-repack.schedule',
      value: 'hourly',
      reason: facts.geometricMaintenance && churn ? 'pack-churn' : null,
      skip: facts.geometricMaintenance ? 'few-packs' : 'no-geometric-maintenance'
    }
  ]
}

function rowFor(key: string, value: string, current: PodGitProfileCurrent) {
  const state = current[key.toLowerCase()] ?? { local: null, other: false, recorded: null }
  const theirs = state.other || (state.local !== null && state.recorded !== state.local)
  return { state, theirs, base: { key, value, current: state.local, source: 'pod' as const } }
}

/** Never overrides: any value Pod did not record is the user's, including `false`. */
export function planPodGitProfile(
  facts: PodGitProfileFacts,
  current: PodGitProfileCurrent
): PodGitProfileRow[] {
  const rows: PodGitProfileRow[] = wantedKeys(facts).map((wanted) => {
    const { state, theirs, base } = rowFor(wanted.key, wanted.value, current)
    if (theirs) {
      return {
        ...base,
        action: state.local === wanted.value ? 'keep' : 'user',
        reason: 'user-value'
      }
    }
    if (wanted.reason === null) {
      return { ...base, action: 'skip', reason: wanted.skip }
    }
    if (state.local === wanted.value) {
      return { ...base, action: 'keep', reason: 'already-set' }
    }
    return { ...base, action: 'set', reason: wanted.reason }
  })
  // Opt-ins: no measured win, so only a tick sets them.
  for (const [optIn, key] of Object.entries(POD_OPT_IN_KEYS)) {
    const { state, theirs, base } = rowFor(key, 'true', current)
    rows.push({
      ...base,
      action: theirs ? 'user' : state.local === 'true' ? 'keep' : 'opt-in',
      reason: theirs ? 'user-value' : optIn
    })
  }
  return rows
}

/** `2.56.0` from `git version 2.56.0 (Apple Git-157)`; null when unparseable. */
export function parseGitVersion(output: string): [number, number, number] | null {
  const match = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(output)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : null
}
