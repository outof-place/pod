// Fork-only (Pod): the hook relay's place in the daemon. Kill switch: POD_AGENT_HOOK_RELAY=0.
import { dirname, join } from 'node:path'
import type { DaemonFileLog } from '../daemon-file-log'
import {
  disablePodHookRelayEndpoints,
  enablePodHookRelayEndpoints
} from './pod-hook-relay-endpoints'
import { PodHookRelay } from './pod-hook-relay-server'

/** What the daemon's PTYs inherit: the relay file Pod's launcher reads. */
export const POD_AGENT_HOOK_RELAY_ENV = 'POD_AGENT_HOOK_RELAY'

export function podHookRelayFilePath(daemonSocketPath: string, protocolVersion: number): string {
  return join(dirname(daemonSocketPath), `pod-hook-relay-v${protocolVersion}.env`)
}

export type DaemonPodHookRelay = { start: () => Promise<void>; close: () => Promise<void> }

/** Null where no launcher can use it (off macOS, or switched off). */
export function createDaemonPodHookRelay(deps: {
  socketPath: string
  protocolVersion: number
  log: DaemonFileLog
}): DaemonPodHookRelay | null {
  const switchedOff = process.env[POD_AGENT_HOOK_RELAY_ENV] === '0'
  // Why: a value inherited from an outer Pod names that Pod's daemon.
  delete process.env[POD_AGENT_HOOK_RELAY_ENV]
  if (process.platform !== 'darwin' || switchedOff) {
    return null
  }
  const relayFilePath = podHookRelayFilePath(deps.socketPath, deps.protocolVersion)
  enablePodHookRelayEndpoints()
  const relay = new PodHookRelay({
    relayFilePath,
    log: (event, details) => deps.log.log(event, details)
  })
  return {
    start: async () => {
      if (await relay.start()) {
        // Why: the daemon's env seeds its PTYs'; terminals opened from now on find the relay (those
        // spawned before the relay is up keep command hooks).
        process.env[POD_AGENT_HOOK_RELAY_ENV] = relayFilePath
      }
    },
    close: async () => {
      delete process.env[POD_AGENT_HOOK_RELAY_ENV]
      disablePodHookRelayEndpoints()
      await relay.close()
    }
  }
}
