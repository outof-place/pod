import { describe, expect, it } from 'vitest'
import { createGlobalSettingsFixture } from '../../../shared/global-settings-test-fixture'
import { pickerExecutionHosts } from '../../../shared/managed-orcad-execution-host'
import { buildPodNotificationSources } from '../../../shared/pod-notification-sources'
import type { SshConnectionState } from '../../../shared/ssh-types'
import { buildNotificationSourceOptions } from './notification-sources'

// Fork-only (Pod): notifications.sources rebuilds this pane's Machines rows in main. If upstream
// changes how the pane picks them, this fails before PodNative's mutes drift from the desktop's.
describe('notifications.sources matches Settings › Notifications › Machines (Pod)', () => {
  const tunnel = { sshTargetGeneration: 1, localPort: 6001, remotePort: 6002 }
  const relay: SshConnectionState = {
    targetId: 'relayed',
    status: 'connected',
    error: null,
    reconnectAttempt: 0,
    managedServer: { kind: 'relay', reason: 'orcad_unavailable' }
  }
  const sshTargetLabels = new Map([
    ['box', 'Build box'],
    ['relayed', 'Relayed box'],
    ['plain', 'Plain host'],
    ['runtime-ssh-vm1', 'VM tunnel']
  ])
  const sshConnectionStates = new Map([['relayed', relay]])
  const runtimeEnvironments = [
    { id: 'hub', name: 'Hub' },
    { id: 'srv', name: 'box server', orcadDeployment: { sshTargetId: 'box', ...tunnel } },
    { id: 'srv2', name: 'relayed server', orcadDeployment: { sshTargetId: 'relayed', ...tunnel } },
    { id: 'vm1', name: 'Scratch VM', source: 'ephemeral-vm' as const }
  ]
  const settings = {
    ...createGlobalSettingsFixture(),
    hostSettingOverrides: { 'ssh:plain': { displayLabel: 'Renamed plain' } }
  }

  it('lists the same machines, names and aliases', () => {
    const pane = pickerExecutionHosts(
      buildNotificationSourceOptions({
        sshTargetLabels,
        sshConnectionStates,
        settings,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pane reads only id, name, source and orcadDeployment.
        runtimeEnvironments: runtimeEnvironments as never,
        runtimeStatusByEnvironmentId: new Map()
      })
    ).map((host) => ({ id: host.id, label: host.label, aliasIds: host.aliasHostIds ?? [] }))

    const sources = buildPodNotificationSources({
      sshTargetLabels,
      sshConnectionStates,
      runtimeEnvironments,
      settings
    })

    expect(sources).toEqual(pane)
    expect(sources.length).toBeGreaterThan(3)
  })
})
