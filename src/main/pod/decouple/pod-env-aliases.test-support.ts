// Fork-only (Pod): the invariant every spawn's final env keeps (pod-env-aliases.ts).
import { expect } from 'vitest'
import { POD_ALIASED_ORCA_ENV_NAMES, podSpellingOf } from '../../../shared/pod-env-aliases'

/** Every aliased POD_ equals its ORCA_, and no aliased POD_ exists without its ORCA_. */
export function expectPodEnvAliasesConsistent(env: Record<string, string | undefined>): void {
  for (const name of POD_ALIASED_ORCA_ENV_NAMES) {
    expect(env[podSpellingOf(name)], podSpellingOf(name)).toBe(env[name])
  }
}

/** A distinct marker per user-settable name, under both spellings. */
export function podUserSettingMarkers(names: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of names) {
    env[name] = `marker-${name}`
    env[podSpellingOf(name)] = `marker-${name}`
  }
  return env
}
