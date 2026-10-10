import React from 'react'
import { Loader2, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  SettingsBadge,
  SettingsSubsectionHeader,
  SettingsSwitch
} from '@/components/settings/SettingsFormControls'
import { translate } from '@/i18n/i18n'
import type { PodOrbstackWorktreeRow } from './pod-orbstack-worktree-rows'

type WorktreeListProps = {
  rows: readonly PodOrbstackWorktreeRow[]
  canCreate: boolean
  onCreate: (row: PodOrbstackWorktreeRow) => void
  onRemove: (row: PodOrbstackWorktreeRow) => void
  onDockerPin: (row: PodOrbstackWorktreeRow, pinned: boolean) => void
}

function MachineCell({
  row,
  canCreate,
  onCreate,
  onRemove
}: Omit<WorktreeListProps, 'rows' | 'onDockerPin'> & {
  row: PodOrbstackWorktreeRow
}): React.JSX.Element {
  if (row.busy) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        {translate('podOrbstack.worktrees.busy', 'Working…')}
      </span>
    )
  }
  if (!row.machine) {
    return (
      <Button variant="outline" size="sm" disabled={!canCreate} onClick={() => onCreate(row)}>
        <Plus className="size-3.5" />
        {translate('podOrbstack.worktrees.create', 'Create machine')}
      </Button>
    )
  }
  return (
    <div className="flex items-center gap-2">
      <SettingsBadge tone={row.machine.missing ? 'muted' : 'accent'} className="font-mono">
        {row.machine.name}
      </SettingsBadge>
      <Button
        variant="ghost"
        size="sm"
        aria-label={translate('podOrbstack.worktrees.remove', 'Delete machine')}
        onClick={() => onRemove(row)}
      >
        <Trash2 className="size-3.5" />
      </Button>
    </div>
  )
}

export function PodOrbstackWorktreeList(props: WorktreeListProps): React.JSX.Element {
  const { rows, onDockerPin } = props
  return (
    <section className="space-y-3">
      <SettingsSubsectionHeader
        title={translate('podOrbstack.worktrees.title', 'Worktree machines')}
        description={translate(
          'podOrbstack.worktrees.description',
          'New terminals of a worktree with a machine open inside it, in the same folder. Agents keep running on this Mac.'
        )}
      />
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {translate('podOrbstack.worktrees.empty', 'No local worktrees.')}
        </p>
      ) : (
        <ul className="divide-y divide-border/60 rounded-lg border border-border/60 px-3">
          {rows.map((row) => (
            <li
              key={row.worktreeId}
              data-testid="pod-orbstack-worktree-row"
              data-worktree-path={row.path}
              className="space-y-2 py-3"
            >
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0 space-y-0.5">
                  <p className="truncate text-sm font-medium">{row.displayName}</p>
                  <p className="truncate font-mono text-xs text-muted-foreground">{row.path}</p>
                </div>
                <div className="shrink-0">
                  <MachineCell {...props} row={row} />
                </div>
              </div>
              <div className="flex items-center justify-between gap-4 text-xs text-muted-foreground">
                <span>
                  {row.containers.length > 0
                    ? translate('podOrbstack.worktrees.containers', 'Containers: {{count}}', {
                        count: row.containers.length
                      })
                    : translate('podOrbstack.worktrees.noContainers', 'No compose containers')}
                </span>
                <label className="inline-flex items-center gap-2">
                  {translate('podOrbstack.worktrees.dockerPin', 'Use OrbStack for Docker')}
                  <SettingsSwitch
                    checked={row.dockerPinned}
                    ariaLabel={translate(
                      'podOrbstack.worktrees.dockerPinLabel',
                      'Set DOCKER_CONTEXT=orbstack in new terminals of {{name}}',
                      { name: row.displayName }
                    )}
                    onChange={() => onDockerPin(row, !row.dockerPinned)}
                  />
                </label>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
