// Fork-only (Pod): pod-decouple renames Pod's env names from ORCA_ to POD_. For one release the
// two sides of that update still meet: daemons, terminals and hook clients from before it.
// TODO(pod): drop after 2026-12-31, and no earlier than the release after the decouple.

export const ENV_SPELLINGS = { legacy: 'ORCA_', current: 'POD_' } as const // pod-decouple:keep

/** `POD_X` as `ORCA_X`; null for a name outside the POD_ spelling. */
export function legacyEnvName(name: string): string | null {
  return name.startsWith(ENV_SPELLINGS.current)
    ? `${ENV_SPELLINGS.legacy}${name.slice(ENV_SPELLINGS.current.length)}`
    : null
}

/** In place: each unset POD_ name takes the value of its ORCA_ spelling, as in a terminal opened
 *  before the update. Before the codemod nothing reads the POD_ copies. */
export function adoptLegacyEnvNames(env: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && name.startsWith(ENV_SPELLINGS.legacy)) {
      const current = `${ENV_SPELLINGS.current}${name.slice(ENV_SPELLINGS.legacy.length)}`
      env[current] ??= value
    }
  }
}
