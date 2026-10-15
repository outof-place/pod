import {
  DEFAULT_BOUNDED_SSH_RELAY_GRACE_PERIOD_SECONDS,
  DEFAULT_SSH_RELAY_GRACE_PERIOD_SECONDS,
  MAX_SSH_RELAY_GRACE_PERIOD_SECONDS,
  MIN_SSH_RELAY_GRACE_PERIOD_SECONDS,
  type SshConfigHostResolution,
  type SshRemoteRuntime,
  type SshTarget
} from '../../../../shared/ssh-types'
import {
  isDefaultSshPortDraft,
  parseSshHostInput,
  resolveSshConnectionFields
} from '../../../../shared/ssh-host-input'

/** `auto` stores nothing, so the host follows DEFAULT_SSH_REMOTE_RUNTIME when it flips. */
export type SshRemoteRuntimeChoice = 'auto' | SshRemoteRuntime

export type EditingTarget = {
  label: string
  configHost: string
  host: string
  port: string
  username: string
  identityFile: string
  gssapiAuthentication: boolean
  proxyCommand: string
  jumpHost: string
  systemSshConnectionReuse: boolean
  relayGracePeriodSeconds: string
  relayKeepAliveUntilReset: boolean
  remoteRuntime: SshRemoteRuntimeChoice
  allowRemoteCliControl: boolean
}

export const EMPTY_FORM: EditingTarget = {
  label: '',
  configHost: '',
  host: '',
  port: '22',
  username: '',
  identityFile: '',
  gssapiAuthentication: false,
  proxyCommand: '',
  jumpHost: '',
  systemSshConnectionReuse: true,
  relayGracePeriodSeconds: String(DEFAULT_BOUNDED_SSH_RELAY_GRACE_PERIOD_SECONDS),
  relayKeepAliveUntilReset: DEFAULT_SSH_RELAY_GRACE_PERIOD_SECONDS === 0,
  remoteRuntime: 'auto',
  allowRemoteCliControl: false
}

export function getEditingTargetForSshTarget(target: SshTarget): EditingTarget {
  // Why: manual targets store configHost as their host. Clear that implicit
  // value on edit so changing Host recomputes the alias instead of keeping stale resolution.
  const configHost = target.configHost && target.configHost !== target.host ? target.configHost : ''
  return {
    label: target.label,
    configHost,
    host: target.host,
    port: String(target.port),
    username: target.username,
    identityFile: target.identityFile ?? '',
    gssapiAuthentication: target.gssapiAuthentication === true,
    proxyCommand: target.proxyCommand ?? '',
    jumpHost: target.jumpHost ?? '',
    systemSshConnectionReuse: target.systemSshConnectionReuse !== false,
    relayGracePeriodSeconds: String(
      target.relayGracePeriodSeconds === 0
        ? DEFAULT_BOUNDED_SSH_RELAY_GRACE_PERIOD_SECONDS
        : (target.relayGracePeriodSeconds ?? DEFAULT_BOUNDED_SSH_RELAY_GRACE_PERIOD_SECONDS)
    ),
    relayKeepAliveUntilReset:
      (target.relayGracePeriodSeconds ?? DEFAULT_SSH_RELAY_GRACE_PERIOD_SECONDS) === 0,
    remoteRuntime: target.remoteRuntime ?? 'auto',
    allowRemoteCliControl: target.allowRemoteCliControl === true
  }
}

/** Prefill the add-host form from a ~/.ssh/config Host entry (does not save). */
export function getEditingTargetFromSshConfigHost(host: SshConfigHostResolution): EditingTarget {
  const configHost = host.alias !== host.hostname ? host.alias : ''
  return {
    ...EMPTY_FORM,
    label: host.alias,
    configHost,
    // Why: keep the config alias in Host when there is no HostName so OpenSSH
    // still resolves User/Port/Identity from ~/.ssh/config on connect.
    host: host.hostname,
    port: String(host.port),
    username: host.username,
    // Why: no scalar override lets connection-time ssh -G retain every IdentityFile.
    identityFile: '',
    gssapiAuthentication: host.gssapiAuthentication === true,
    proxyCommand: host.proxyCommand ?? '',
    jumpHost: host.jumpHost ?? ''
  }
}

export function applyParsedSshHostInput(draft: EditingTarget): EditingTarget {
  const parsed = parseSshHostInput(draft.host)
  // Why: keep bad host:port text visible so the user can correct it after
  // the save validator reports the invalid port.
  if (!parsed || parsed.invalidPort) {
    return draft
  }

  return {
    ...draft,
    host: parsed.host,
    configHost: draft.configHost.trim() || parsed.configHost,
    username: draft.username.trim() || parsed.username || '',
    port:
      parsed.port !== undefined && isDefaultSshPortDraft(draft.port)
        ? String(parsed.port)
        : draft.port
  }
}

export function getSshTargetDraftConnectionFields(draft: EditingTarget): {
  host: string
  configHost: string
  username: string
  port: number
} {
  return resolveSshConnectionFields(draft)
}

export function hasAdvancedConnectionValues(form: EditingTarget): boolean {
  return (
    form.proxyCommand.trim().length > 0 ||
    form.jumpHost.trim().length > 0 ||
    !form.systemSshConnectionReuse ||
    form.remoteRuntime !== 'auto' ||
    form.allowRemoteCliControl
  )
}

export function isSshTargetFormDirty(current: EditingTarget, baseline: EditingTarget): boolean {
  return (
    current.label !== baseline.label ||
    current.configHost !== baseline.configHost ||
    current.host !== baseline.host ||
    current.port !== baseline.port ||
    current.username !== baseline.username ||
    current.identityFile !== baseline.identityFile ||
    current.gssapiAuthentication !== baseline.gssapiAuthentication ||
    current.proxyCommand !== baseline.proxyCommand ||
    current.jumpHost !== baseline.jumpHost ||
    current.systemSshConnectionReuse !== baseline.systemSshConnectionReuse ||
    current.relayGracePeriodSeconds !== baseline.relayGracePeriodSeconds ||
    current.relayKeepAliveUntilReset !== baseline.relayKeepAliveUntilReset ||
    current.remoteRuntime !== baseline.remoteRuntime ||
    current.allowRemoteCliControl !== baseline.allowRemoteCliControl
  )
}

export function parseRelayGracePeriodSeconds(draft: EditingTarget): number {
  return draft.relayKeepAliveUntilReset ? 0 : Number.parseInt(draft.relayGracePeriodSeconds, 10)
}

export function isRelayGracePeriodValid(draft: EditingTarget, graceSeconds: number): boolean {
  return (
    draft.relayKeepAliveUntilReset ||
    (!Number.isNaN(graceSeconds) &&
      graceSeconds >= MIN_SSH_RELAY_GRACE_PERIOD_SECONDS &&
      graceSeconds <= MAX_SSH_RELAY_GRACE_PERIOD_SECONDS)
  )
}
