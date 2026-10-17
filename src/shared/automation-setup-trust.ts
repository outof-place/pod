// Fork-only (Pod): what an automation keeps of its orca.yaml setup trust.
export type AutomationSetupTrust = {
  /** The hash of the base's orca.yaml setup the user approved at save. Each run sends it, so a host
   *  without the client's trust record runs that content, and only that. */
  setupTrustHash?: string | null
}

/** What a run shows when its setup was skipped because the base isn't the repo's own branch. */
export const FOREIGN_BASE_SETUP_SKIPPED = 'setup skipped: base is outside your branches'

export type AutomationRunSetupNotice = {
  /** Pod: why the host skipped this run's setup, shown with the run. */
  setupNotice?: string | null
}

type SetupTrustTarget = AutomationSetupTrust & {
  projectId: string
  workspaceMode: string
  baseBranch?: string | null
  runContext?: { hostId: string; repoId: string; path: string } | null
}

function trustTargetKey(target: SetupTrustTarget): string {
  const context = target.runContext
  return JSON.stringify([
    target.projectId,
    target.workspaceMode,
    target.baseBranch ?? null,
    context?.hostId ?? null,
    context?.repoId ?? null,
    context?.path ?? null
  ])
}

/** The hash an updated automation keeps. One approved for another base, repo, host or mode is
 *  dropped, even when the new target's orca.yaml is identical (a fork's ref can copy it); only a hash
 *  the same update brings, asked on the new target, survives such a change. */
export function updatedSetupTrustHash(
  current: SetupTrustTarget,
  next: SetupTrustTarget,
  updates: AutomationSetupTrust
): string | null {
  if (next.workspaceMode !== 'new_per_run') {
    return null
  }
  if (Object.hasOwn(updates, 'setupTrustHash')) {
    return updates.setupTrustHash ?? null
  }
  return trustTargetKey(next) === trustTargetKey(current) ? (current.setupTrustHash ?? null) : null
}
