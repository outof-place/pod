// Fork-only (Pod): SSH settings' host operations for runtime RPC, installed by the IPC layer so the
// runtime's module graph stays free of Electron (config/runtime-electron-baseline.txt).
import {
  DEFAULT_SSH_RELAY_GRACE_PERIOD_SECONDS,
  type SshRepoReadoption,
  type SshTarget,
  type SshTargetCreateInput,
  type SshTargetUpdateInput
} from '../../../shared/ssh-types'
import type { SshTargetSettingsInput } from '../../../shared/rpc-contract/pod-ssh-target-params'
import { isManagedOrcadSshTarget } from '../../ssh/ssh-connection-store'

/** The same calls SSH settings' IPC handlers make (ssh-target-crud-handlers.ts). */
export type PodSshTargetSettingsOps = {
  add(target: SshTargetCreateInput): { target: SshTarget; repoReadoptions: SshRepoReadoption[] }
  update(id: string, updates: SshTargetUpdateInput): SshTarget | null
  /** Ends the host's terminals best effort, then removes it, as the pane's Remove does. */
  remove(id: string): Promise<void>
  importConfig(args: { reAdopt?: boolean }): {
    targets: SshTarget[]
    repoReadoptions: SshRepoReadoption[]
  }
  disconnect(id: string): Promise<void>
}

let installed: PodSshTargetSettingsOps | null = null

export function setPodSshTargetSettingsOps(ops: PodSshTargetSettingsOps | null): void {
  installed = ops
}

/** Null on a host whose SSH layer never registered (orcad). */
export function getPodSshTargetSettingsOps(): PodSshTargetSettingsOps | null {
  return installed
}

/** A host as SSH settings edits it. No credentials: the target store keeps none. */
export type SshTargetConfig = Pick<
  SshTarget,
  | 'id'
  | 'label'
  | 'configHost'
  | 'host'
  | 'port'
  | 'username'
  | 'identityFile'
  | 'gssapiAuthentication'
  | 'proxyCommand'
  | 'jumpHost'
  | 'source'
  | 'relayGracePeriodSeconds'
  | 'systemSshConnectionReuse'
  | 'remoteRuntime'
  | 'allowRemoteCliControl'
  | 'generation'
> & {
  /** Serves a managed Orca server: Remove refuses it, as the pane does. */
  managedServer: boolean
}

// Why a pick: the store's rows also hold main-owned state (fences, provisioning, port forwards).
export function toSshTargetConfig(target: SshTarget): SshTargetConfig {
  return {
    id: target.id,
    label: target.label,
    configHost: target.configHost,
    host: target.host,
    port: target.port,
    username: target.username,
    identityFile: target.identityFile,
    gssapiAuthentication: target.gssapiAuthentication,
    proxyCommand: target.proxyCommand,
    jumpHost: target.jumpHost,
    source: target.source,
    relayGracePeriodSeconds: target.relayGracePeriodSeconds,
    systemSshConnectionReuse: target.systemSshConnectionReuse,
    remoteRuntime: target.remoteRuntime,
    allowRemoteCliControl: target.allowRemoteCliControl,
    generation: target.generation,
    managedServer: isManagedOrcadSshTarget(target)
  }
}

/**
 * The pane's save payload (buildSshTargetSavePayload) from a validated form: what Add stores, and
 * what Save writes over an existing host. Cleared optional fields are written as undefined, since
 * the store merges an update; a saved host becomes `manual` so ~/.ssh/config sync leaves it alone.
 */
export function buildSshTargetSettingsPayload(input: SshTargetSettingsInput): {
  target: SshTargetCreateInput
  updates: SshTargetUpdateInput
} {
  const host = input.host
  const configHost = input.configHost || host
  const username = input.username ?? ''
  const identityFile = input.identityFile || undefined
  const proxyCommand = input.proxyCommand || undefined
  const jumpHost = input.jumpHost || undefined
  const systemSshConnectionReuse = input.systemSshConnectionReuse === false ? false : undefined
  const target: SshTargetCreateInput = {
    label: input.label || (username ? `${username}@${host}` : configHost),
    configHost,
    host,
    port: input.port,
    username,
    ...(input.gssapiAuthentication ? { gssapiAuthentication: true } : {}),
    relayGracePeriodSeconds:
      input.relayGracePeriodSeconds ?? DEFAULT_SSH_RELAY_GRACE_PERIOD_SECONDS,
    ...(identityFile ? { identityFile } : {}),
    ...(proxyCommand ? { proxyCommand } : {}),
    ...(jumpHost ? { jumpHost } : {}),
    ...(systemSshConnectionReuse === false ? { systemSshConnectionReuse } : {}),
    ...(input.remoteRuntime ? { remoteRuntime: input.remoteRuntime } : {}),
    ...(input.allowRemoteCliControl ? { allowRemoteCliControl: true } : {})
  }
  return {
    target,
    updates: {
      ...target,
      identityFile,
      gssapiAuthentication: input.gssapiAuthentication || undefined,
      proxyCommand,
      jumpHost,
      systemSshConnectionReuse,
      remoteRuntime: input.remoteRuntime,
      allowRemoteCliControl: input.allowRemoteCliControl || undefined,
      source: 'manual'
    }
  }
}
