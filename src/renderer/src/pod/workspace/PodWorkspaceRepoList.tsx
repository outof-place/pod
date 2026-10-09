import React from 'react'
import { GitBranch } from 'lucide-react'
import type {
  PodWorkspaceGitTuning,
  PodWorkspaceRepoRow,
  PodWorkspaceStatus
} from '../../../../shared/pod-workspace-types'
import { SettingsBadge, SettingsSubsectionHeader } from '@/components/settings/SettingsFormControls'
import { translate } from '@/i18n/i18n'
import { displayPathUnderRoot } from './pod-workspace-display'

function tuningChips(tuning: PodWorkspaceGitTuning | null): string[] {
  if (!tuning) {
    return []
  }
  const chips: string[] = []
  if (tuning.untrackedCache !== null) {
    chips.push(`core.untrackedCache=${tuning.untrackedCache}`)
  }
  if (tuning.fsmonitor !== null) {
    chips.push(`core.fsmonitor=${tuning.fsmonitor}`)
  }
  if (tuning.indexVersion !== null) {
    chips.push(`index.version=${tuning.indexVersion}`)
  }
  if (tuning.checkoutWorkers !== null) {
    chips.push(`checkout.workers=${tuning.checkoutWorkers}`)
  }
  return chips
}

function indexLabel(row: PodWorkspaceRepoRow, connected: boolean): string | null {
  if (!connected) {
    return null
  }
  if (!row.index) {
    return translate('podWorkspace.repo.index.none', 'Not indexed')
  }
  return translate('podWorkspace.repo.index.state', 'Index {{state}} · {{docs}} files', {
    state: row.index.state,
    docs: row.index.docs.toLocaleString()
  })
}

function RepoRow({
  row,
  rootAliases,
  indexConnected
}: {
  row: PodWorkspaceRepoRow
  rootAliases: readonly string[]
  indexConnected: boolean
}): React.JSX.Element {
  const chips = tuningChips(row.gitTuning)
  const index = indexLabel(row, indexConnected)
  return (
    <li data-testid="pod-workspace-repo-row" className="space-y-1.5 py-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-0.5">
          <p className="truncate text-sm font-medium">{row.displayName}</p>
          <p className="truncate font-mono text-xs text-muted-foreground">
            {displayPathUnderRoot(row.path, rootAliases)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
          {row.branch ? (
            <span className="inline-flex items-center gap-1">
              <GitBranch className="size-3.5" />
              {row.branch}
            </span>
          ) : null}
          {row.worktreeCount !== null ? (
            <span>
              {translate('podWorkspace.repo.worktrees', 'Worktrees: {{count}}', {
                count: row.worktreeCount
              })}
            </span>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {chips.length === 0 ? (
          <SettingsBadge tone="muted">
            {translate('podWorkspace.repo.tuning.none', 'No git tuning set')}
          </SettingsBadge>
        ) : (
          chips.map((chip) => (
            <SettingsBadge key={chip} className="font-mono">
              {chip}
            </SettingsBadge>
          ))
        )}
        {row.gitTuning?.orcaPerformanceConfig ? (
          <SettingsBadge tone="accent">
            {translate('podWorkspace.repo.tuning.orca', 'Applied by Orca')}
          </SettingsBadge>
        ) : null}
        {index ? <SettingsBadge tone="muted">{index}</SettingsBadge> : null}
      </div>
    </li>
  )
}

export function PodWorkspaceRepoList({
  status
}: {
  status: PodWorkspaceStatus
}): React.JSX.Element {
  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <SettingsSubsectionHeader
          title={translate('podWorkspace.repos.title', 'Repositories in the workspace root')}
          description={translate(
            'podWorkspace.repos.description',
            'Local git projects under {{root}}.',
            {
              root: status.root
            }
          )}
        />
        {status.repos.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {translate(
              'podWorkspace.repos.empty',
              'No projects here yet. Clone one from Add Project; it lands in <root>/<owner>/<repo>.'
            )}
          </p>
        ) : (
          <ul className="divide-y divide-border/60 rounded-lg border border-border/60 px-3">
            {status.repos.map((row) => (
              <RepoRow
                key={row.repoId}
                row={row}
                rootAliases={status.rootAliases}
                indexConnected={status.indexConnected}
              />
            ))}
          </ul>
        )}
      </section>
      {status.outsideRepos.length > 0 ? (
        <section className="space-y-3">
          <SettingsSubsectionHeader
            title={translate('podWorkspace.outside.title', 'Outside the workspace root')}
            description={
              status.migrationScript.exists
                ? translate(
                    'podWorkspace.outside.migrate',
                    'These stay where they are. To move them under the root, run {{script}}.',
                    { script: status.migrationScript.path }
                  )
                : translate(
                    'podWorkspace.outside.migrateMissing',
                    'These stay where they are. The migration script ({{script}}) is not installed.',
                    { script: status.migrationScript.path }
                  )
            }
          />
          <ul
            data-testid="pod-workspace-outside-list"
            className="divide-y divide-border/60 rounded-lg border border-border/60 px-3"
          >
            {status.outsideRepos.map((repo) => (
              <li key={repo.repoId} className="flex items-center justify-between gap-4 py-2">
                <span className="truncate text-sm">{repo.displayName}</span>
                <span className="truncate font-mono text-xs text-muted-foreground">
                  {repo.path}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}
