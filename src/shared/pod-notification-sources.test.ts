import { describe, expect, it } from 'vitest'
import { getLocalExecutionHostLabel } from './execution-host'
import {
  buildPodNotificationSources,
  type PodNotificationSourceCatalog
} from './pod-notification-sources'
import type { SshConnectionState } from './ssh-types'

const LOCAL = { id: 'local', label: getLocalExecutionHostLabel(), aliasIds: [] }

function catalog(
  overrides: Partial<PodNotificationSourceCatalog> = {}
): PodNotificationSourceCatalog {
  return {
    sshTargetLabels: new Map(),
    sshConnectionStates: new Map(),
    runtimeEnvironments: [],
    settings: null,
    ...overrides
  }
}

const deployment = (sshTargetId: string) => ({
  sshTargetId,
  sshTargetGeneration: 1,
  localPort: 6001,
  remotePort: 6002
})

describe('buildPodNotificationSources (Pod)', () => {
  it('lists this computer alone when nothing else is configured', () => {
    expect(buildPodNotificationSources(catalog())).toEqual([LOCAL])
  })

  it('lists SSH hosts and paired servers, never runtime-owned targets or VMs', () => {
    const sources = buildPodNotificationSources(
      catalog({
        sshTargetLabels: new Map([
          ['box', 'Build box'],
          ['runtime-ssh-vm1', 'VM tunnel']
        ]),
        runtimeEnvironments: [
          { id: 'hub', name: 'Hub' },
          { id: 'vm1', name: 'Scratch VM', source: 'ephemeral-vm' }
        ]
      })
    )
    expect(sources).toEqual(
      expect.arrayContaining([
        LOCAL,
        { id: 'ssh:box', label: 'Build box', aliasIds: [] },
        { id: 'runtime:hub', label: 'Hub', aliasIds: [] }
      ])
    )
    expect(sources).toHaveLength(3)
  })

  it('shows an SSH host and its managed server as one machine, under the host name', () => {
    const managed = catalog({
      sshTargetLabels: new Map([['box', 'Build box']]),
      runtimeEnvironments: [{ id: 'srv', name: 'box server', orcadDeployment: deployment('box') }]
    })
    expect(buildPodNotificationSources(managed)).toEqual([
      LOCAL,
      { id: 'runtime:srv', label: 'Build box', aliasIds: ['ssh:box'] }
    ])

    // On the relay, the SSH host is the row and the server its alias.
    const relay: SshConnectionState = {
      targetId: 'box',
      status: 'connected',
      error: null,
      reconnectAttempt: 0,
      managedServer: { kind: 'relay', reason: 'orcad_unavailable' }
    }
    expect(
      buildPodNotificationSources({
        ...managed,
        sshConnectionStates: new Map([['box', relay]])
      })
    ).toEqual([LOCAL, { id: 'ssh:box', label: 'Build box', aliasIds: ['runtime:srv'] }])
  })

  it('names a machine by its rename, saved on either of its ids', () => {
    const sources = buildPodNotificationSources(
      catalog({
        sshTargetLabels: new Map([['box', 'Build box']]),
        runtimeEnvironments: [
          { id: 'srv', name: 'box server', orcadDeployment: deployment('box') }
        ],
        settings: { hostSettingOverrides: { 'ssh:box': { displayLabel: 'Rack 3' } } }
      })
    )
    expect(sources).toContainEqual({ id: 'runtime:srv', label: 'Rack 3', aliasIds: ['ssh:box'] })
  })
})
