// Fork-only (Pod): pod-decouple renames the daemon's env names to POD_ without a protocol bump, so
// an adopted daemon from before the update still reads ORCA_ ones. A daemon whose hello names no
// handle env, or another one, gets the ORCA_ twin of every renamed POD_ name too.
// TODO(pod): drop after 2026-12-31, and no earlier than the release after the decouple.
import type { DaemonEndpointIdentity } from '../../daemon/daemon-hello-protocol'
import type { PtySpawnOptions } from '../../providers/types'
import { renamedLegacyEnvName } from '../../../shared/pod-legacy-env-names'

/** Where this build's daemon reads a terminal's handle; the codemod renames it with the rest. */
export const TERMINAL_HANDLE_ENV = 'POD_TERMINAL_HANDLE'

export function daemonReadsLegacyEnv(identity: DaemonEndpointIdentity | null): boolean {
  return identity?.terminalHandleEnv !== TERMINAL_HANDLE_ENV
}

/** The env plus the ORCA_ twin of each renamed name; a twin the env sets itself keeps its value. */
export function withLegacyEnvTwins(env: Record<string, string>): Record<string, string> {
  const twins: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) {
    const twin = renamedLegacyEnvName(name)
    if (twin !== null && !Object.hasOwn(env, twin)) {
      twins[twin] = value
    }
  }
  return { ...env, ...twins }
}

export function withLegacyEnvTwinsToDelete(names: readonly string[]): string[] {
  const twins = names
    .map(renamedLegacyEnvName)
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
