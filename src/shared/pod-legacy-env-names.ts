// Fork-only (Pod): pod-decouple renames Pod's env names from ORCA_ to POD_. For one release the
// two sides of that update still meet: daemons, terminals and hook clients from before it.
// TODO(pod): drop after 2026-12-31, and no earlier than the release after the decouple.
import { RENAMED_ENV_NAMES } from './pod-renamed-env-names'

export const ENV_SPELLINGS = { legacy: 'ORCA_', current: 'POD_' } as const // pod-decouple:keep

/** `POD_X` as `ORCA_X`; null for a name outside the POD_ spelling. */
export function legacyEnvName(name: string): string | null {
  return name.startsWith(ENV_SPELLINGS.current)
    ? `${ENV_SPELLINGS.legacy}${name.slice(ENV_SPELLINGS.current.length)}`
    : null
}

// Renamed name to its ORCA_ spelling and back. Before the codemod the list is ORCA_ already, so
// both are empty and every function below changes nothing.
const LEGACY_SPELLING = new Map(
  RENAMED_ENV_NAMES.flatMap((name) => {
    const legacy = legacyEnvName(name)
    return legacy === null ? [] : [[name, legacy] as const]
  })
)
const CURRENT_SPELLING = new Map([...LEGACY_SPELLING].map(([current, legacy]) => [legacy, current]))

/** Whether this tree is past the codemod, so the overlap has names to work on. */
export const ENV_DECOUPLED = LEGACY_SPELLING.size > 0

/** The ORCA_ spelling of a name pod-decouple renamed; null for any other name. */
export function renamedLegacyEnvName(name: string): string | null {
  return LEGACY_SPELLING.get(name) ?? null
}

/** Pod's data folder name, product/identity.json's userDataName (pod-legacy-env-names.test.ts). */
export const POD_USER_DATA_NAME = 'Pod'

/** Whether a resolved `path` is the resolved `folder` or lies below it. The ORCA_ env of a
 *  terminal counts only in this Pod's data folder: an Orca.app terminal's points at Orca's. */
export function isInFolder(path: string, folder: string): boolean {
  return path === folder || path.startsWith(folder.endsWith('/') ? folder : `${folder}/`)
}

/** In place: each unset renamed POD_ name takes the value of its ORCA_ spelling, as in a terminal
 *  opened before the update. Callers check first that the env is a Pod terminal's. */
export function adoptLegacyEnvNames(env: Record<string, string | undefined>): void {
  for (const [current, legacy] of LEGACY_SPELLING) {
    const value = env[legacy]
    if (value !== undefined) {
      env[current] ??= value
    }
  }
}

/** A spawn request from a runtime before the decouple (a rollback that adopts this daemon) names
 *  its env ORCA_: each renamed POD_ name it leaves unset takes the ORCA_ value, which stays too. */
export function withCurrentEnvSpelling(
  env: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!env) {
    return env
  }
  let adopted: Record<string, string> | undefined
  for (const [name, value] of Object.entries(env)) {
    const current = CURRENT_SPELLING.get(name)
    if (current !== undefined && !Object.hasOwn(env, current)) {
      adopted ??= { ...env }
      adopted[current] = value
    }
  }
  return adopted ?? env
}

/** The same request's deletions: an ORCA_ name deletes its POD_ spelling too, unless env sets it. */
export function withCurrentEnvSpellingToDelete(
  names: string[] | undefined,
  env: Record<string, string> | undefined
): string[] | undefined {
  if (!names) {
    return names
  }
  const added = names.flatMap((name) => {
    const current = CURRENT_SPELLING.get(name)
    return current !== undefined && !names.includes(current) && !Object.hasOwn(env ?? {}, current)
      ? [current]
      : []
  })
  return added.length > 0 ? [...names, ...added] : names
}

/** In place, on a copy of the env a new terminal inherits: the ORCA_ spelling of each renamed name
 *  goes. The dual-read clients would take it for this runtime's, e.g. the hook endpoint a dev
 *  runtime inherits from a live Pod's pane. A request that sets one still wins: it merges after. */
export function stripInheritedLegacyEnv(env: Record<string, string | undefined>): void {
  for (const legacy of LEGACY_SPELLING.values()) {
    delete env[legacy]
  }
}
