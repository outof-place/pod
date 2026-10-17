// Fork-only (Pod): the orca.yaml a create's setup trust is asked about.
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { checkRuntimeHooks, type HookCheckResult } from '@/runtime/runtime-hooks-client'
import type { OrcaHooks, RepoHookSettings } from '../../../shared/orca-yaml-hook-types'
import { hookRunContent } from '../../../shared/orca-yaml-run-content'

/** Pod: a create's setup is asked about on its base's orca.yaml, and the approved hash goes with
 *  the create so the host can check the content it actually runs. `foreign`: the create is linked
 *  to a pull or merge request; a base the host says isn't the repo's own branch is foreign too, and
 *  then neither "Always trust" nor a recorded hash answers for it (the host doesn't count them). */
export type CreateSetupTrust = {
  baseRef?: string
  foreign?: boolean
  onTrusted: (contentHash: string) => void
}

/** What the question shows and hashes: orca.yaml's setup (with its default tab commands) or
 *  archive script, none when the repo runs its own commands only; for someone else's code
 *  everything a run would start there, the repo's own script included (`make clean` runs that
 *  branch's Makefile). Other kinds: `other`. */
export function hookTrustContent(
  kind: string,
  foreign: boolean,
  localOnly: boolean,
  hookSettings: RepoHookSettings | undefined,
  yamlHooks: OrcaHooks | null,
  other: () => string
): string {
  if (kind !== 'setup' && kind !== 'archive') {
    return other()
  }
  if (foreign) {
    return hookRunContent(kind, hookSettings, yamlHooks)
  }
  return localOnly ? '' : hookRunContent(kind, undefined, yamlHooks)
}

/** A direct launch from a work item: a pull or merge request's head is someone else's code. */
export function workItemCreateSetupTrust(
  itemType: string,
  baseRef: string | undefined,
  onTrusted: (contentHash: string) => void
): CreateSetupTrust {
  return { baseRef, foreign: itemType === 'pr' || itemType === 'mr', onTrusted }
}

/** The hooks a create runs, its base's: the root's when the host can't read the base (an older
 *  host, a ref only the create resolves), as the host still checks what it runs. */
export async function readCreateSetupHooks(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  repoId: string,
  hostId: ExecutionHostId | undefined,
  createSetup: CreateSetupTrust | undefined
): Promise<{ result: HookCheckResult; foreign: boolean }> {
  const atBase = createSetup?.baseRef
    ? await checkRuntimeHooks(settings, repoId, hostId, createSetup.baseRef)
    : null
  const foreign = createSetup?.foreign === true || atBase?.baseOwned === false
  const result =
    atBase && atBase.status !== 'error' ? atBase : await checkRuntimeHooks(settings, repoId, hostId)
  return { result, foreign }
}
