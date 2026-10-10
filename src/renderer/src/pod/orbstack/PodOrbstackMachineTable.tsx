import React from 'react'
import { Play, Square } from 'lucide-react'
import type { PodOrbstackMachine } from '../../../../shared/pod-orbstack-types'
import { Button } from '@/components/ui/button'
import { SettingsBadge, SettingsSubsectionHeader } from '@/components/settings/SettingsFormControls'
import { translate } from '@/i18n/i18n'

function describeImage(machine: PodOrbstackMachine): string {
  return [machine.distro, machine.distroVersion, machine.arch].filter(Boolean).join(' · ')
}

export function PodOrbstackMachineTable({
  machines,
  pendingName,
  onSetRunning
}: {
  machines: readonly PodOrbstackMachine[]
  pendingName: string | null
  onSetRunning: (name: string, running: boolean) => void
}): React.JSX.Element {
  return (
    <section className="space-y-3">
      <SettingsSubsectionHeader
        title={translate('podOrbstack.machines.title', 'Linux machines')}
        description={translate(
          'podOrbstack.machines.description',
          'Pod starts and stops only the machines it created. Your other machines are shown read-only.'
        )}
      />
      {machines.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {translate('podOrbstack.machines.empty', 'No Linux machines.')}
        </p>
      ) : (
        <ul className="divide-y divide-border/60 rounded-lg border border-border/60 px-3">
          {machines.map((machine) => {
            const running = machine.state === 'running'
            const canToggle =
              machine.podOwned && !machine.missing && (running || machine.state === 'stopped')
            return (
              <li
                key={machine.name}
                data-testid="pod-orbstack-machine-row"
                data-machine={machine.name}
                className="flex items-center justify-between gap-4 py-2.5"
              >
                <div className="min-w-0 space-y-0.5">
                  <p className="truncate font-mono text-sm">{machine.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {describeImage(machine) ||
                      translate('podOrbstack.machines.noImage', 'Image unknown')}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {machine.podOwned ? (
                    <SettingsBadge tone="accent">
                      {translate('podOrbstack.machines.pod', 'Pod')}
                    </SettingsBadge>
                  ) : null}
                  <SettingsBadge tone={running ? 'neutral' : 'muted'}>
                    {machine.state}
                  </SettingsBadge>
                  {canToggle ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={pendingName === machine.name}
                      onClick={() => onSetRunning(machine.name, !running)}
                    >
                      {running ? <Square className="size-3.5" /> : <Play className="size-3.5" />}
                      {running
                        ? translate('podOrbstack.machines.stop', 'Stop')
                        : translate('podOrbstack.machines.start', 'Start')}
                    </Button>
                  ) : null}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
