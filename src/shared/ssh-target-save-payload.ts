// What SSH settings stores for a validated host form: Add writes `target`, Save writes `updates`
// over the existing host. The settings pane and the ssh.addTarget and ssh.updateTarget RPCs share it.
import type { SshRemoteRuntime, SshTargetCreateInput, SshTargetUpdateInput } from './ssh-types'

/** Connection fields already resolved (ssh-host-input.ts) and checked; strings may still carry padding. */
export type SshTargetPayloadFields = {
  label: string
  configHost: string
  host: string
  port: number
  username: string
  identityFile: string
  gssapiAuthentication: boolean
  proxyCommand: string
  jumpHost: string
  systemSshConnectionReuse: boolean
  relayGracePeriodSeconds: number
  /** Undefined: automatic. */
  remoteRuntime: SshRemoteRuntime | undefined
  allowRemoteCliControl: boolean
}

export function buildSshTargetPayloads(fields: SshTargetPayloadFields): {
  target: SshTargetCreateInput
  updates: SshTargetUpdateInput
} {
  const { host, configHost, username, port, remoteRuntime } = fields
  const identityFile = fields.identityFile.trim() || undefined
  const proxyCommand = fields.proxyCommand.trim() || undefined
  const jumpHost = fields.jumpHost.trim() || undefined
  const systemSshConnectionReuse = fields.systemSshConnectionReuse ? undefined : false

  const target: SshTargetCreateInput = {
    label: fields.label.trim() || (username ? `${username}@${host}` : configHost),
    configHost,
    host,
    port,
    username,
    ...(fields.gssapiAuthentication ? { gssapiAuthentication: true } : {}),
    relayGracePeriodSeconds: fields.relayGracePeriodSeconds,
    ...(identityFile ? { identityFile } : {}),
    ...(proxyCommand ? { proxyCommand } : {}),
    ...(jumpHost ? { jumpHost } : {}),
    ...(systemSshConnectionReuse === false ? { systemSshConnectionReuse } : {}),
    ...(remoteRuntime ? { remoteRuntime } : {}),
    ...(fields.allowRemoteCliControl ? { allowRemoteCliControl: true } : {})
  }

  return {
    target,
    updates: {
      ...target,
      // Why: updateTarget merges partially, so explicit undefined values are
      // required to clear optional fields inherited from ~/.ssh/config.
      identityFile,
      gssapiAuthentication: fields.gssapiAuthentication || undefined,
      proxyCommand,
      jumpHost,
      systemSshConnectionReuse,
      remoteRuntime,
      allowRemoteCliControl: fields.allowRemoteCliControl || undefined,
      source: 'manual'
    }
  }
}
