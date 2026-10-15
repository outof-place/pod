import {
  MAX_SSH_RELAY_GRACE_PERIOD_SECONDS,
  type SshTargetCreateInput,
  type SshTargetUpdateInput
} from '../../../../shared/ssh-types'
import {
  getSshTargetDraftConnectionFields,
  isRelayGracePeriodValid,
  parseRelayGracePeriodSeconds,
  type EditingTarget
} from './ssh-target-draft'
import { buildSshTargetPayloads } from '../../../../shared/ssh-target-save-payload'
import { translate } from '../../i18n/i18n'

type SshTargetSavePayload = {
  target: SshTargetCreateInput
  updates: SshTargetUpdateInput
}

type SshTargetSavePayloadResult =
  | { ok: true; payload: SshTargetSavePayload }
  | { ok: false; error: string }

export function buildSshTargetSavePayload(form: EditingTarget): SshTargetSavePayloadResult {
  const { host, configHost, username, port } = getSshTargetDraftConnectionFields(form)
  if (!host) {
    return {
      ok: false,
      error: translate(
        'auto.components.settings.SshPane.0e5aa04161',
        'Host or SSH config alias is required'
      )
    }
  }

  if (Number.isNaN(port) || port < 1 || port > 65535) {
    return {
      ok: false,
      error: translate(
        'auto.components.settings.SshPane.4db9afce1c',
        'Port must be between 1 and 65535'
      )
    }
  }

  const graceSeconds = parseRelayGracePeriodSeconds(form)
  if (!isRelayGracePeriodValid(form, graceSeconds)) {
    return {
      ok: false,
      error: translate(
        'auto.components.settings.SshPane.3879cbaa52',
        'Terminal timeout must be between 60 and {{value0}} seconds, or keep terminals alive until reset.',
        { value0: MAX_SSH_RELAY_GRACE_PERIOD_SECONDS }
      )
    }
  }

  return {
    ok: true,
    payload: buildSshTargetPayloads({
      label: form.label,
      configHost,
      host,
      port,
      username,
      identityFile: form.identityFile,
      gssapiAuthentication: form.gssapiAuthentication,
      proxyCommand: form.proxyCommand,
      jumpHost: form.jumpHost,
      systemSshConnectionReuse: form.systemSshConnectionReuse,
      relayGracePeriodSeconds: graceSeconds,
      remoteRuntime: form.remoteRuntime === 'auto' ? undefined : form.remoteRuntime,
      allowRemoteCliControl: form.allowRemoteCliControl
    })
  }
}
