// Fork-only (Pod): the invariant every spawn's final env keeps (pod-env-aliases.ts).
import { expect, vi } from 'vitest'
import { POD_ALIASED_ORCA_ENV_NAMES, podSpellingOf } from '../../../shared/pod-env-aliases'
import type { IPtyProvider } from '../../providers/types'

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

/** A fully typed provider that only spawns; every other member is a bare spy. */
export function podEnvAliasProviderDouble(
  spawn: IPtyProvider['spawn'],
  overrides: Partial<IPtyProvider> = {}
): IPtyProvider {
  return {
    spawn,
    attach: vi.fn(),
    write: vi.fn(),
    writeWithSettlement: vi.fn(),
    resize: vi.fn(),
    shutdown: vi.fn(),
    sendSignal: vi.fn(),
    getCwd: vi.fn(),
    getInitialCwd: vi.fn(),
    clearBuffer: vi.fn(),
    resetInputModes: vi.fn(),
    acknowledgeDataEvent: vi.fn(),
    hasChildProcesses: vi.fn(),
    getForegroundProcess: vi.fn(),
    serialize: vi.fn(),
    revive: vi.fn(),
    listProcesses: vi.fn(async () => []),
    getDefaultShell: vi.fn(),
    getProfiles: vi.fn(),
    onData: vi.fn(() => () => {}),
    onReplay: vi.fn(() => () => {}),
    onExit: vi.fn(() => () => {}),
    ...overrides
  }
}
