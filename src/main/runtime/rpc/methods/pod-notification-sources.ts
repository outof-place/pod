// Fork-only (Pod): notifications.sources, the per-machine mutes' rows for PodNative's Notifications page.
import { defineMethod } from '../core'
import { getAppEnvironment } from '../../../../shared/app-environment'
import { listEnvironments } from '../../../../shared/runtime-environment-store'
import { buildPodNotificationSources } from '../../../../shared/pod-notification-sources'
import type { SshConnectionState } from '../../../../shared/ssh-types'
import { getRegisteredSshState, listRegisteredSshTargets } from '../../../ssh/ssh-target-registry'
import { assertLocalRpcCaller } from './pod-local-caller'

export const POD_NOTIFICATION_SOURCE_METHODS = [
  // Why local and host-admin: the mutes are this computer's, and the rows name its SSH hosts.
  defineMethod({
    name: 'notifications.sources',
    permission: 'host-admin',
    params: null,
    handler: (_params, ctx) => {
      assertLocalRpcCaller(ctx, 'notifications.sources')
      const targets = listRegisteredSshTargets()
      const sshConnectionStates = new Map<string, SshConnectionState>()
      for (const target of targets) {
        const state = getRegisteredSshState(target.id)
        if (state) {
          sshConnectionStates.set(target.id, state)
        }
      }
      return {
        sources: buildPodNotificationSources({
          sshTargetLabels: new Map(targets.map((target) => [target.id, target.label])),
          sshConnectionStates,
          // Only what names a machine: endpoints carry device tokens.
          runtimeEnvironments: listEnvironments(getAppEnvironment().getPath('userData')).map(
            ({ id, name, source, orcadDeployment }) => ({ id, name, source, orcadDeployment })
          ),
          settings: ctx.runtime.getClientSettings()
        })
      }
    }
  })
]
