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

// Renamed name to its ORCA_ spelling. Before the codemod the list is ORCA_ already, so the map is
// empty and every function below changes nothing.
const LEGACY_SPELLING = new Map(
  RENAMED_ENV_NAMES.flatMap((name) => {
    const legacy = legacyEnvName(name)
    return legacy === null ? [] : [[name, legacy] as const]
  })
)

/** Whether this tree is past the codemod, so the overlap has names to work on. */
export const ENV_DECOUPLED = LEGACY_SPELLING.size > 0

/** The ORCA_ spelling of a name pod-decouple renamed; null for any other name. */
export function renamedLegacyEnvName(name: string): string | null {
  return LEGACY_SPELLING.get(name) ?? null
}

/** In place: each unset renamed POD_ name takes the value of its ORCA_ spelling, as in a terminal
 *  opened before the update. */
export function adoptLegacyEnvNames(env: Record<string, string | undefined>): void {
  for (const [current, legacy] of LEGACY_SPELLING) {
    const value = env[legacy]
    if (value !== undefined) {
      env[current] ??= value
    }
  }
}
