import React from 'react'
import { ShieldCheck, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SettingsBadge, SettingsSwitch } from '@/components/settings/SettingsFormControls'
import { translate } from '@/i18n/i18n'
import type { PodOrbstackWorktreeRow } from './pod-orbstack-worktree-rows'

export type PodOrbstackSandboxActions = {
  onCreateSandbox: (row: PodOrbstackWorktreeRow) => void
  onDeleteSandbox: (row: PodOrbstackWorktreeRow) => void
  onAgentSandbox: (row: PodOrbstackWorktreeRow, enabled: boolean) => void
}

/** The worktree's isolated agent machine: it sees only this worktree and reaches Pod through OrbStack. */
export function PodOrbstackSandboxRow({
  row,
  canCreate,
  onCreateSandbox,
  onDeleteSandbox,
  onAgentSandbox
}: PodOrbstackSandboxActions & {
  row: PodOrbstackWorktreeRow
  canCreate: boolean
}): React.JSX.Element {
  // Sandboxes from before --isolate-network reach the Mac's localhost; Pod no longer runs agents there.
  const legacy = row.sandbox !== null && row.sandboxReady && !row.sandboxNetworkIsolated
  const ready = row.sandbox !== null && row.sandboxReady && !row.sandbox.missing && !legacy
  return (
    <div
      data-testid="pod-orbstack-sandbox-row"
      className="flex items-center justify-between gap-4 text-xs text-muted-foreground"
    >
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <ShieldCheck className="size-3.5 shrink-0" />
        {row.sandbox ? (
          <>
            <SettingsBadge tone={ready ? 'accent' : 'muted'} className="font-mono">
              {row.sandbox.name}
            </SettingsBadge>
            {legacy ? (
              <span className="truncate">
                {translate(
                  'podOrbstack.sandbox.legacy',
                  'Not network-isolated. Delete and recreate it to use it.'
                )}
              </span>
            ) : row.sandboxAgentVersion ? (
              <span className="truncate">
                {translate('podOrbstack.sandbox.version', 'Claude Code {{version}}', {
                  version: row.sandboxAgentVersion
                })}
              </span>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              disabled={row.busy}
              aria-label={translate('podOrbstack.sandbox.delete', 'Delete agent sandbox')}
              onClick={() => onDeleteSandbox(row)}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </>
        ) : (
          <Button
            variant="outline"
            size="sm"
            disabled={!canCreate || row.busy}
            onClick={() => onCreateSandbox(row)}
          >
            {translate('podOrbstack.sandbox.create', 'Create agent sandbox')}
          </Button>
        )}
      </span>
      <label className="inline-flex shrink-0 items-center gap-2">
        {translate('podOrbstack.sandbox.agents', 'Run Claude in the sandbox')}
        <SettingsSwitch
          checked={row.sandboxAgents}
          disabled={!ready || row.busy}
          ariaLabel={translate(
            'podOrbstack.sandbox.agentsLabel',
            'Run Claude launches of {{name}} in its OrbStack sandbox',
            { name: row.displayName }
          )}
          onChange={() => onAgentSandbox(row, !row.sandboxAgents)}
        />
      </label>
    </div>
  )
}
