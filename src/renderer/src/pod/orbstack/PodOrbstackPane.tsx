import React, { useMemo, useState } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import type {
  PodOrbstackActionResult,
  PodOrbstackStatus
} from '../../../../shared/pod-orbstack-types'
import { Button } from '@/components/ui/button'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import { SettingsBadge, SettingsSubsectionHeader } from '@/components/settings/SettingsFormControls'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { podOrbstackRpc } from './pod-orbstack-rpc'
import { runPodOrbstackAction } from './pod-orbstack-actions'
import { buildPodOrbstackWorktreeRows } from './pod-orbstack-worktree-rows'
import { PodOrbstackClaudeLoginRow } from './PodOrbstackClaudeLoginRow'
import { PodOrbstackContainerTable } from './PodOrbstackContainerTable'
import { PodOrbstackMachineTable } from './PodOrbstackMachineTable'
import { PodOrbstackWorktreeList } from './PodOrbstackWorktreeList'
import { usePodOrbstackStatus } from './use-pod-orbstack-status'

function serviceLabel(status: PodOrbstackStatus): string {
  if (!status.install.orbPath) {
    return translate('podOrbstack.service.missing', 'Not installed')
  }
  if (status.service === 'running') {
    return translate('podOrbstack.service.running', 'Running')
  }
  return status.service === 'stopped'
    ? translate('podOrbstack.service.stopped', 'Stopped')
    : translate('podOrbstack.service.unknown', 'Unknown')
}

function StatusSummary({ status }: { status: PodOrbstackStatus }): React.JSX.Element {
  const context = status.dockerContext
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="pod-orbstack-summary">
      <SettingsBadge tone={status.service === 'running' ? 'accent' : 'muted'}>
        {translate('podOrbstack.summary.service', 'OrbStack: {{state}}', {
          state: serviceLabel(status)
        })}
      </SettingsBadge>
      {status.install.version ? (
        <SettingsBadge tone="muted">{status.install.version}</SettingsBadge>
      ) : null}
      <SettingsBadge tone={context.currentIsOrbstack ? 'accent' : 'muted'}>
        {context.current
          ? translate('podOrbstack.summary.context', 'Docker context: {{name}}', {
              name: context.current
            })
          : translate('podOrbstack.summary.noDocker', 'Docker CLI not found')}
      </SettingsBadge>
      {context.current && !context.currentIsOrbstack && context.orbstackContextExists ? (
        <span className="text-muted-foreground">
          {translate(
            'podOrbstack.summary.contextHint',
            'Docker talks to another engine. Turn on "Use OrbStack for Docker" for a worktree to pin it there.'
          )}
        </span>
      ) : null}
    </div>
  )
}

export function PodOrbstackPane(): React.JSX.Element {
  const { status, loading, error, refresh } = usePodOrbstackStatus()
  const repos = useAppStore((state) => state.repos)
  const worktreesByRepo = useAppStore((state) => state.worktreesByRepo)
  const [pendingMachine, setPendingMachine] = useState<string | null>(null)
  const [pendingWorktrees, setPendingWorktrees] = useState<ReadonlySet<string>>(new Set())
  const [claudeLoginBusy, setClaudeLoginBusy] = useState(false)
  const confirm = useConfirmationDialog()
  // Why it asks with counts: a restart stops every running container and machine on the Mac.
  const restartOrbstack = (): void => {
    const containers = status?.containers.filter((item) => item.state === 'running').length ?? 0
    const machines = status?.machines.filter((item) => item.state === 'running').length ?? 0
    void confirm({
      title: translate('podOrbstack.restart.title', 'Restart OrbStack?'),
      description: translate(
        'podOrbstack.restart.description',
        "Restarting stops every running container and machine on this Mac, not only Pod's: {{containers}} containers and {{machines}} machines run now. Containers set to restart come back on their own; terminals and agents in a machine end.",
        { containers: String(containers), machines: String(machines) }
      ),
      confirmLabel: translate('podOrbstack.restart.confirm', 'Restart OrbStack'),
      confirmVariant: 'destructive'
    }).then((confirmed) => {
      if (confirmed) {
        void runPodOrbstackAction(() => podOrbstackRpc.restart(), refresh)
      }
    })
  }
  const rows = useMemo(
    () =>
      (status ? buildPodOrbstackWorktreeRows(repos, worktreesByRepo, status) : []).map((row) =>
        pendingWorktrees.has(row.worktreeId) ? { ...row, busy: true } : row
      ),
    [repos, worktreesByRepo, status, pendingWorktrees]
  )
  const worktreeNameByContainerId = useMemo(
    () =>
      new Map(
        rows.flatMap((row) => row.containers.map((container) => [container.id, row.displayName]))
      ),
    [rows]
  )
  const runForWorktree = (
    worktreeId: string,
    action: () => Promise<PodOrbstackActionResult>
  ): void => {
    setPendingWorktrees((current) => new Set([...current, worktreeId]))
    void runPodOrbstackAction(action, refresh, restartOrbstack).finally(() =>
      setPendingWorktrees((current) => new Set([...current].filter((id) => id !== worktreeId)))
    )
  }

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <SettingsSubsectionHeader
          title={translate('podOrbstack.status.title', 'Status')}
          description={translate(
            'podOrbstack.status.description',
            'Pod only reads OrbStack, except for the machines it creates for worktrees.'
          )}
          action={
            <Button
              variant="outline"
              size="sm"
              className="w-32"
              disabled={loading}
              onClick={() => void refresh()}
            >
              {loading ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              {translate('podOrbstack.status.refresh', 'Refresh')}
            </Button>
          }
        />
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        {status ? <StatusSummary status={status} /> : null}
        {status?.churn && status.churn.creates >= status.churn.warnAt ? (
          <p className="text-xs text-muted-foreground" data-testid="pod-orbstack-churn">
            {translate(
              'podOrbstack.churn.warning',
              'Pod made {{count}} machines since OrbStack started. OrbStack keeps the address of each deleted machine for about a day, so new machines may soon get none until those expire or OrbStack is updated.',
              { count: status.churn.creates }
            )}
          </p>
        ) : null}
        {status?.errors.map((message) => (
          <p key={message} className="font-mono text-xs text-muted-foreground">
            {message}
          </p>
        ))}
      </section>
      {status ? (
        <>
          <PodOrbstackWorktreeList
            rows={rows}
            canCreate={status.install.orbPath !== null}
            onCreate={(row) =>
              runForWorktree(row.worktreeId, () =>
                podOrbstackRpc.createMachine(row.worktreeId, row.displayName)
              )
            }
            onRemove={(row) =>
              runForWorktree(row.worktreeId, () => podOrbstackRpc.deleteMachine(row.worktreeId))
            }
            onCreateSandbox={(row) =>
              runForWorktree(row.worktreeId, () =>
                podOrbstackRpc.createSandbox(row.worktreeId, row.displayName)
              )
            }
            onDeleteSandbox={(row) =>
              runForWorktree(row.worktreeId, () => podOrbstackRpc.deleteSandbox(row.worktreeId))
            }
            onAgentSandbox={(row, enabled) =>
              void runPodOrbstackAction(
                () => podOrbstackRpc.setAgentSandbox(row.worktreeId, enabled),
                refresh
              )
            }
            onDockerPin={(row, pinned) =>
              void runPodOrbstackAction(
                () => podOrbstackRpc.pinDocker(row.worktreeId, pinned),
                refresh
              )
            }
          />
          <PodOrbstackClaudeLoginRow
            enabled={status.sandboxClaudeLogin}
            busy={claudeLoginBusy}
            onChange={(enabled) => {
              setClaudeLoginBusy(true)
              void runPodOrbstackAction(
                () => podOrbstackRpc.setSandboxClaudeLogin(enabled),
                refresh
              ).finally(() => setClaudeLoginBusy(false))
            }}
          />
          <PodOrbstackMachineTable
            machines={status.machines}
            pendingName={pendingMachine}
            onSetRunning={(name, running) => {
              setPendingMachine(name)
              void runPodOrbstackAction(
                () =>
                  running ? podOrbstackRpc.startMachine(name) : podOrbstackRpc.stopMachine(name),
                refresh,
                restartOrbstack
              ).finally(() => setPendingMachine(null))
            }}
          />
          <PodOrbstackContainerTable
            containers={status.containers}
            worktreeNameByContainerId={worktreeNameByContainerId}
          />
        </>
      ) : null}
    </div>
  )
}
