// Fork-only (Pod): pod-decouple renames the daemon's env names to POD_ without a protocol bump, so
// an adopted daemon from before the update still reads ORCA_ ones. A daemon whose hello names no
// handle env, or another one, gets the ORCA_ twin of every POD_ name too; one that reads POD_ only.
// TODO(pod): drop after 2026-12-31, and no earlier than the release after the decouple.
import type { DaemonEndpointIdentity } from '../../daemon/daemon-hello-protocol'
import type { PtySpawnOptions } from '../../providers/types'

/** Where this build's daemon reads a terminal's handle; the codemod renames it with the rest. */
export const TERMINAL_HANDLE_ENV = 'ORCA_TERMINAL_HANDLE'

const SPELLINGS = { legacy: 'ORCA_', current: 'POD_' } as const // pod-decouple:keep

function legacyTwin(name: string): string | null {
  return name.startsWith(SPELLINGS.current)
    ? `${SPELLINGS.legacy}${name.slice(SPELLINGS.current.length)}`
    : null
}

export function daemonReadsLegacyEnv(identity: DaemonEndpointIdentity | null): boolean {
  return identity?.terminalHandleEnv !== TERMINAL_HANDLE_ENV
}

/** The env plus the ORCA_ twin of each POD_ name; a twin the env sets itself keeps its value. */
export function withLegacyEnvTwins(env: Record<string, string>): Record<string, string> {
  const twins: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) {
    const twin = legacyTwin(name)
    if (twin !== null && !Object.hasOwn(env, twin)) {
      twins[twin] = value
    }
  }
  return { ...env, ...twins }
}

export function withLegacyEnvTwinsToDelete(names: readonly string[]): string[] {
  const twins = names
    .map(legacyTwin)
    .filter((twin): twin is string => twin !== null && !names.includes(twin))
  return [...names, ...twins]
}

/** What a spawn request to this daemon carries: unchanged unless the daemon reads ORCA_ names. */
export function spawnOptionsForDaemon(
  opts: PtySpawnOptions,
  identity: DaemonEndpointIdentity | null
): PtySpawnOptions {
  if (!daemonReadsLegacyEnv(identity) || (!opts.env && !opts.envToDelete)) {
    return opts
  }
  return {
    ...opts,
    ...(opts.env ? { env: withLegacyEnvTwins(opts.env) } : {}),
    ...(opts.envToDelete ? { envToDelete: withLegacyEnvTwinsToDelete(opts.envToDelete) } : {})
  }
}
