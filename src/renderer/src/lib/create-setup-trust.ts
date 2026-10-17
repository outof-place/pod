// Fork-only (Pod): the orca.yaml a create's setup trust is asked about.
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { checkRuntimeHooks, type HookCheckResult } from '@/runtime/runtime-hooks-client'

/** Pod: a create's setup is asked about on its base's orca.yaml, and the approved hash goes with
 *  the create so the host can check the content it actually runs. `foreign`: the create is linked
 *  to a pull or merge request; a base the host says isn't the repo's own branch is foreign too, and
 *  then neither "Always trust" nor a recorded hash answers for it (the host doesn't count them). */
export type CreateSetupTrust = {
  baseRef?: string
  foreign?: boolean
  onTrusted: (contentHash: string) => void
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
