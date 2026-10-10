import React from 'react'
import type { PodOrbstackContainer } from '../../../../shared/pod-orbstack-types'
import { SettingsBadge, SettingsSubsectionHeader } from '@/components/settings/SettingsFormControls'
import { translate } from '@/i18n/i18n'

export function PodOrbstackContainerTable({
  containers,
  worktreeNameByContainerId
}: {
  containers: readonly PodOrbstackContainer[]
  /** Containers whose compose project lives in a worktree, to that worktree's name. */
  worktreeNameByContainerId: ReadonlyMap<string, string>
}): React.JSX.Element {
  return (
    <section className="space-y-3">
      <SettingsSubsectionHeader
        title={translate('podOrbstack.containers.title', 'Docker containers')}
        description={translate(
          'podOrbstack.containers.description',
          'Read from the orbstack Docker context. CPU and memory are shown for running containers.'
        )}
      />
      {containers.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {translate('podOrbstack.containers.empty', 'No containers.')}
        </p>
      ) : (
        <ul className="divide-y divide-border/60 rounded-lg border border-border/60 px-3">
          {containers.map((container) => {
            const worktree = worktreeNameByContainerId.get(container.id)
            return (
              <li
                key={container.id}
                data-testid="pod-orbstack-container-row"
                className="flex items-center justify-between gap-4 py-2.5"
              >
                <div className="min-w-0 space-y-0.5">
                  <p className="truncate text-sm">{container.name}</p>
                  <p className="truncate font-mono text-xs text-muted-foreground">
                    {container.image}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                  {container.cpuPercent ? (
                    <span className="tabular-nums">{container.cpuPercent}</span>
                  ) : null}
                  {container.memoryUsage ? (
                    <span className="tabular-nums">{container.memoryUsage}</span>
                  ) : null}
                  {worktree ? <SettingsBadge tone="accent">{worktree}</SettingsBadge> : null}
                  {container.composeProject ? (
                    <SettingsBadge tone="muted">{container.composeProject}</SettingsBadge>
                  ) : null}
                  <SettingsBadge tone={container.state === 'running' ? 'neutral' : 'muted'}>
                    {container.state}
                  </SettingsBadge>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
