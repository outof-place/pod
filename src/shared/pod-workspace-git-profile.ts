// Fork-only (Pod): the git config Pod sets in the repositories it manages, and the pure planner
// that decides it. Measured on a 35k-file, 13k-commit repo with 22k refs (git 2.56, M4 Max).

/** Multi-valued `<key>=<value>` record of what Pod wrote, so a revert removes exactly that. */
export const POD_GIT_PROFILE_RECORD_KEY = 'pod.workspaceConfig'

/** Repos at least this big get the file watcher and index v4: status 808 → 135 M instructions. */
export const POD_GIT_PROFILE_LARGE_REPO_FILES = 10_000

/** Pack count above which Pod repacks hourly rather than daily (lazy-fetch churn). */
export const POD_GIT_PROFILE_MANY_PACKS = 50

export type PodGitProfileKey =
  | 'core.untrackedCache'
  | 'core.fsmonitor'
  | 'index.version'
  | 'checkout.workers'
  | 'fetch.writeCommitGraph'
  | 'maintenance.strategy'
  | 'maintenance.prefetch.enabled'
  | 'maintenance.geometric-repack.schedule'

export type PodGitProfileFacts = {
  gitVersion: readonly [number, number, number] | null
  trackedFiles: number | null
  packCount: number | null
  partialClone: boolean
  /** `git fsmonitor--daemon status` accepted the worktree (it refuses network mounts). */
  fsmonitorSupported: boolean
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

export type PodGitProfileAction = 'set' | 'keep' | 'user' | 'skip'

export type PodGitProfileReason =
  | 'always'
  | 'large-repo'
  | 'small-repo'
  | 'git-too-old'
  | 'fsmonitor-unsupported'
  | 'no-geometric-maintenance'
  | 'pack-churn'
  | 'few-packs'
  | 'user-value'
  | 'already-set'

export type PodGitProfileRow = {
  key: PodGitProfileKey
  value: string
  action: PodGitProfileAction
  reason: PodGitProfileReason
  /** What the repository has now; null when unset. */
  current: string | null
}

type Wanted = { key: PodGitProfileKey; value: string; when: () => PodGitProfileReason | null }

function atLeast(version: PodGitProfileFacts['gitVersion'], major: number, minor: number): boolean {
  if (!version) {
    return false
  }
  return version[0] > major || (version[0] === major && version[1] >= minor)
}

function wantedKeys(facts: PodGitProfileFacts): { entry: Wanted; skip: PodGitProfileReason }[] {
  const large = (facts.trackedFiles ?? 0) >= POD_GIT_PROFILE_LARGE_REPO_FILES
  const churn = facts.partialClone || (facts.packCount ?? 0) > POD_GIT_PROFILE_MANY_PACKS
  const geometric = (): PodGitProfileReason | null => (facts.geometricMaintenance ? 'always' : null)
  return [
    { entry: { key: 'core.untrackedCache', value: 'true', when: () => 'always' }, skip: 'always' },
    {
      entry: {
        key: 'core.fsmonitor',
        value: 'true',
        // Why 2.37: the builtin daemon. Older Git reads `true` as a hook name and misses edits.
        when: () =>
          large && facts.fsmonitorSupported && atLeast(facts.gitVersion, 2, 37)
            ? 'large-repo'
            : null
      },
      skip: !large
        ? 'small-repo'
        : !facts.fsmonitorSupported
          ? 'fsmonitor-unsupported'
          : 'git-too-old'
    },
    {
      entry: { key: 'index.version', value: '4', when: () => (large ? 'large-repo' : null) },
      skip: 'small-repo'
    },
    {
      entry: {
        key: 'checkout.workers',
        value: '0',
        when: () => (atLeast(facts.gitVersion, 2, 32) ? 'always' : null)
      },
      skip: 'git-too-old'
    },
    {
      entry: { key: 'fetch.writeCommitGraph', value: 'true', when: () => 'always' },
      skip: 'always'
    },
    {
      entry: { key: 'maintenance.strategy', value: 'geometric', when: geometric },
      skip: 'no-geometric-maintenance'
    },
    {
      // Why: Pod fetches on its own; an hourly background fetch per repo costs a metered link.
      entry: { key: 'maintenance.prefetch.enabled', value: 'false', when: geometric },
      skip: 'no-geometric-maintenance'
    },
    {
      // Why: a blobless clone gains a pack per lazy fetch (50-90 a minute measured); each costs
      // every later git command an index probe. Daily repack lets thousands pile up.
      entry: {
        key: 'maintenance.geometric-repack.schedule',
        value: 'hourly',
        when: () => (facts.geometricMaintenance && churn ? 'pack-churn' : null)
      },
      skip: facts.geometricMaintenance ? 'few-packs' : 'no-geometric-maintenance'
    }
  ]
}

/** Never overrides: any value Pod did not record is the user's, including `false`. */
export function planPodGitProfile(
  facts: PodGitProfileFacts,
  current: PodGitProfileCurrent
): PodGitProfileRow[] {
  return wantedKeys(facts).map(({ entry, skip }) => {
    const state = current[entry.key.toLowerCase()] ?? { local: null, other: false, recorded: null }
    const reason = entry.when()
    const base = { key: entry.key, value: entry.value, current: state.local }
    if (state.other || (state.local !== null && state.recorded !== state.local)) {
      return {
        ...base,
        action: state.local === entry.value ? 'keep' : 'user',
        reason: 'user-value'
      }
    }
    if (reason === null) {
      return { ...base, action: 'skip', reason: skip }
    }
    if (state.local === entry.value) {
      return { ...base, action: 'keep', reason: 'already-set' }
    }
    return { ...base, action: 'set', reason }
  })
}

/** `2.56.0` from `git version 2.56.0 (Apple Git-157)`; null when unparseable. */
export function parseGitVersion(output: string): [number, number, number] | null {
  const match = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(output)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : null
}
