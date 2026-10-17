// Fork-only (Pod): one import plan from Orca's read state and Pod's current one.
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type {
  PodOrcaImportItem,
  PodOrcaImportLeftBehind
} from '../../../shared/pod-orca-import-types'
import type { Repo } from '../../../shared/repo-types'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import { planKeybindings, type KeybindingAction } from './orca-import-plan-keybindings'
import {
  orcaRepos,
  planRepos,
  type OrcaImportFsProbe,
  type RepoAction,
  type WorktreeAction
} from './orca-import-plan-repos'
import {
  planQuickCommands,
  planSettings,
  planThemes,
  type QuickCommandAction,
  type SettingAction,
  type ThemeAction
} from './orca-import-plan-settings'

export type OrcaImportAction =
  | RepoAction
  | WorktreeAction
  | SettingAction
  | ThemeAction
  | QuickCommandAction
  | KeybindingAction

export type OrcaImportPlan = {
  items: PodOrcaImportItem[]
  /** Only items with something to do; keyed by item id. */
  actions: ReadonlyMap<string, OrcaImportAction>
  leftBehind: PodOrcaImportLeftBehind[]
}

export type OrcaImportPlanInput = {
  orca: ReadonlyMap<string, unknown>
  pod: {
    repos: Repo[]
    worktreeMeta: Record<string, WorktreeMeta>
    settings: GlobalSettings
    defaults: GlobalSettings
  }
  keybindings: { orcaPath: string | null; podPath: string } | null
  fs: OrcaImportFsProbe
  platform?: NodeJS.Platform
}

function count(value: unknown): number {
  if (Array.isArray(value)) {
    return value.length
  }
  return value !== null && typeof value === 'object' ? Object.keys(value).length : 0
}

function leftBehind(orca: ReadonlyMap<string, unknown>): PodOrcaImportLeftBehind[] {
  const tallies: PodOrcaImportLeftBehind[] = [
    { kind: 'sshTargets', count: count(orca.get('sshTargets')) },
    { kind: 'automations', count: count(orca.get('automations')) },
    { kind: 'projectGroups', count: count(orca.get('projectGroups')) }
  ]
  const counted = tallies.filter((entry) => (entry.count ?? 0) > 0)
  const hooked = orcaRepos(orca.get('repos')).filter((repo) => repo.hookSettings).length
  return [
    // Never read: they belong to Orca's running terminals, its browser and its sign-ins.
    { kind: 'terminals', count: null },
    { kind: 'sessions', count: null },
    { kind: 'browser', count: null },
    { kind: 'accounts', count: null },
    { kind: 'pairedDevices', count: null },
    { kind: 'encryptedSettings', count: null },
    ...counted,
    ...(hooked > 0 ? [{ kind: 'hookSettings' as const, count: hooked }] : [])
  ]
}

export function buildOrcaImportPlan(input: OrcaImportPlanInput): OrcaImportPlan {
  const repos = orcaRepos(input.orca.get('repos'))
  const settings = input.orca.get('settings')
  const planned = [
    ...planRepos({
      orcaRepos: repos,
      orcaWorktreeMeta: input.orca.get('worktreeMeta'),
      podRepos: input.pod.repos,
      podWorktreeMeta: input.pod.worktreeMeta,
      fs: input.fs
    }),
    ...planSettings(settings, input.pod.settings, input.pod.defaults),
    ...planThemes(settings, input.pod.settings),
    ...planQuickCommands(
      settings,
      input.pod.settings,
      new Map(repos.map((repo) => [repo.id, repo.path]))
    ),
    ...(input.keybindings
      ? planKeybindings(input.keybindings.orcaPath, input.keybindings.podPath, input.platform)
      : [])
  ]
  const actions = new Map<string, OrcaImportAction>()
  const items: PodOrcaImportItem[] = []
  const seen = new Set<string>()
  // Why first wins: two Orca rows for one path (a re-added project) are one Pod row.
  for (const entry of planned) {
    if (seen.has(entry.item.id)) {
      continue
    }
    seen.add(entry.item.id)
    items.push(entry.item)
    if (entry.action) {
      actions.set(entry.item.id, entry.action)
    }
  }
  return { items, actions, leftBehind: leftBehind(input.orca) }
}
