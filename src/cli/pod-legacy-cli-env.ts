// Fork-only (Pod): podx in a terminal opened before the decouple update sees only ORCA_ names.
// They count only in a Pod terminal: in an Orca.app terminal they name Orca's runtime and token.
// TODO(pod): drop after 2026-12-31, and no earlier than the release after the decouple.
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { getProductIdentity } from '../main/product-identity/product-identity'
import {
  adoptLegacyEnvNames,
  isInFolder,
  POD_USER_DATA_NAME,
  renamedLegacyEnvName
} from '../shared/pod-legacy-env-names'

function resolved(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

/** Whether `userData` lies in Pod's data folder under `home`, both resolved. */
function isPodsUserData(userData: string, home: string | undefined): boolean {
  const path = resolved(userData)
  const folder = home
    ? resolved(join(home, 'Library', 'Application Support', POD_USER_DATA_NAME))
    : null
  return path !== null && folder !== null && isInFolder(path, folder)
}

/** Adopts a Pod terminal's ORCA_ names. False, once it has said why, when they name another app's
 *  runtime and nothing names Pod's. */
export function adoptLegacyCliEnv(
  env: NodeJS.ProcessEnv = process.env,
  writeError: (line: string) => void = (line) => process.stderr.write(line)
): boolean {
  const legacyName = renamedLegacyEnvName('ORCA_USER_DATA_PATH')
  const named = legacyName === null ? undefined : env[legacyName]
  if (named === undefined) {
    return true
  }
  if (isPodsUserData(named, env.HOME)) {
    adoptLegacyEnvNames(env)
    return true
  }
  if (env.ORCA_USER_DATA_PATH) {
    return true
  }
  const cliName = getProductIdentity()?.cliName ?? 'podx'
  writeError(
    `${cliName}: no ${POD_USER_DATA_NAME} runtime in env: ${legacyName} is another app's data (${named})\n`
  )
  return false
}
