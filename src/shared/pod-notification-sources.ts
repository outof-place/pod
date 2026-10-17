// Fork-only (Pod): notifications.sources, the machines Settings › Notifications › Machines lists.
import { buildExecutionHostRegistry } from './execution-host-registry'
import { getHostDisplayLabelOverrides } from './host-setting-overrides'
import type { GlobalSettings } from './global-settings-types'
import { pickerExecutionHosts } from './managed-orcad-execution-host'
import { notificationSourceForOwner, type NotificationSourceId } from './notification-source'
import type { PublicKnownRuntimeEnvironment } from './runtime-environments'
import type { SshConnectionState } from './ssh-types'

export type PodNotificationSource = {
  id: NotificationSourceId
  label: string
  /** Every other id the machine stands for (an SSH host and its managed server): mute them together. */
  aliasIds: NotificationSourceId[]
}

export type PodNotificationSourceCatalog = {
  sshTargetLabels: ReadonlyMap<string, string>
  sshConnectionStates: ReadonlyMap<string, SshConnectionState>
  runtimeEnvironments: readonly Pick<
    PublicKnownRuntimeEnvironment,
    'id' | 'name' | 'source' | 'orcadDeployment'
  >[]
  settings: Pick<GlobalSettings, 'hostSettingOverrides'> | null
}

/** The renderer's buildNotificationSourceOptions + pickerExecutionHosts, one row per machine. */
export function buildPodNotificationSources(
  catalog: PodNotificationSourceCatalog
): PodNotificationSource[] {
  const hosts = buildExecutionHostRegistry({
    repos: [],
    settings: null,
    hostSource: 'configured-only',
    sshTargetLabels: catalog.sshTargetLabels,
    sshConnectionStates: catalog.sshConnectionStates,
    runtimeEnvironments: catalog.runtimeEnvironments,
    hostLabelOverrides: getHostDisplayLabelOverrides(catalog.settings)
  }).filter(
    (entry) =>
      notificationSourceForOwner(
        { executionHostId: entry.id, runtimeEnvironmentId: null },
        catalog
      ) === entry.id
  )
  return pickerExecutionHosts(hosts).map((host) => ({
    id: host.id,
    label: host.label,
    aliasIds: [...(host.aliasHostIds ?? [])]
  }))
}
