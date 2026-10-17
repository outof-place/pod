// Fork-only (Pod): applies the items a user picked, through Pod's own runtime and settings paths.
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { PodOrcaImportItemOutcome } from '../../../shared/pod-orca-import-types'
import type { Repo } from '../../../shared/repo-types'
import {
  CUSTOM_TERMINAL_THEME_PREFIX,
  MAX_TERMINAL_CUSTOM_THEMES,
  type TerminalCustomTheme
} from '../../../shared/terminal-custom-themes'
import type { TerminalQuickCommand } from '../../../shared/terminal-quick-command-types'
import { WORKTREE_ID_SEPARATOR } from '../../../shared/worktree/id'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path'
import { writeKeybindingOverride } from '../../keybindings/keybinding-file'
import type { OrcaImportAction, OrcaImportPlan } from './orca-import-plan'
import type { RepoAction, WorktreeAction } from './orca-import-plan-repos'
import type { QuickCommandAction, SettingAction, ThemeAction } from './orca-import-plan-settings'
import type { KeybindingAction } from './orca-import-plan-keybindings'

export type OrcaImportApplyPorts = {
  getRepos(): Repo[]
  getSettings(): GlobalSettings
  addRepo(
    path: string,
    kind: 'git' | 'folder',
    hostId: undefined,
    displayName: string
  ): Promise<Repo>
  updateRepo(selector: string, updates: Partial<Repo>): Promise<Repo>
  updateWorktreeMeta(selector: string, updates: Partial<WorktreeMeta>): Promise<unknown>
  /** settings:set's own write path: same sanitizing and side effects as a Settings change. */
  writeSettings(values: Partial<GlobalSettings>): Promise<GlobalSettings>
  keybindings: { path(): string; reload(): void } | null
  platform: NodeJS.Platform
}

type Outcomes = Map<string, PodOrcaImportItemOutcome>

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function samePath(left: string, right: string): boolean {
  return normalizeRuntimePathForComparison(left) === normalizeRuntimePathForComparison(right)
}

function selectedActions<A extends OrcaImportAction>(
  plan: OrcaImportPlan,
  selected: ReadonlySet<string>,
  isKind: (action: OrcaImportAction) => action is A
): [string, A][] {
  const picked: [string, A][] = []
  for (const [id, action] of plan.actions) {
    if (selected.has(id) && isKind(action)) {
      picked.push([id, action])
    }
  }
  return picked
}

const isRepo = (action: OrcaImportAction): action is RepoAction => action.kind === 'repo'
const isWorktree = (action: OrcaImportAction): action is WorktreeAction =>
  action.kind === 'worktree'
const isSetting = (action: OrcaImportAction): action is SettingAction => action.kind === 'setting'
const isTheme = (action: OrcaImportAction): action is ThemeAction => action.kind === 'theme'
const isQuickCommand = (action: OrcaImportAction): action is QuickCommandAction =>
  action.kind === 'quickCommand'
const isKeybinding = (action: OrcaImportAction): action is KeybindingAction =>
  action.kind === 'keybinding'

/** The ids to apply: the picked ones, plus the new project a picked worktree belongs to. */
export function expandSelection(plan: OrcaImportPlan, itemIds: readonly string[]): Set<string> {
  const selected = new Set(itemIds.filter((id) => plan.actions.has(id)))
  // A project added while iterating has nothing to add in turn.
  for (const id of selected) {
    const action = plan.actions.get(id)
    if (action?.kind === 'worktree' && plan.actions.has(action.repoItemId)) {
      selected.add(action.repoItemId)
    }
  }
  return selected
}

async function applyRepos(
  entries: [string, RepoAction][],
  ports: OrcaImportApplyPorts,
  outcomes: Outcomes
): Promise<void> {
  for (const [id, action] of entries) {
    try {
      const repo = await ports.addRepo(action.path, action.repoKind, undefined, action.displayName)
      if (Object.keys(action.fields).length > 0) {
        await ports.updateRepo(`id:${repo.id}`, action.fields)
      }
      outcomes.set(id, { id, outcome: 'imported' })
    } catch (error) {
      outcomes.set(id, { id, outcome: 'failed', message: message(error) })
    }
  }
}

function podRepoFor(path: string, ports: OrcaImportApplyPorts): Repo | undefined {
  return ports.getRepos().find((repo) => !repo.connectionId && samePath(repo.path, path))
}

async function applyWorktrees(
  entries: [string, WorktreeAction][],
  ports: OrcaImportApplyPorts,
  outcomes: Outcomes
): Promise<void> {
  const byRepo = new Map<string, [string, WorktreeAction][]>()
  for (const entry of entries) {
    byRepo.set(entry[1].repoPath, [...(byRepo.get(entry[1].repoPath) ?? []), entry])
  }
  for (const [repoPath, group] of byRepo) {
    const repo = podRepoFor(repoPath, ports)
    if (!repo) {
      for (const [id] of group) {
        outcomes.set(id, { id, outcome: 'skipped', message: 'Its project is not in Pod.' })
      }
      continue
    }
    // Why: Pod hides worktrees it didn't create; the ones Orca listed are shown by name.
    const shown = repo.importedExternalWorktreePaths ?? []
    const added = group
      .map(([, action]) => action)
      .filter((action) => !action.isMain && !shown.some((path) => samePath(path, action.path)))
      .map((action) => action.path)
    if (added.length > 0) {
      try {
        await ports.updateRepo(`id:${repo.id}`, {
          importedExternalWorktreePaths: [...shown, ...added]
        })
      } catch (error) {
        for (const [id] of group) {
          outcomes.set(id, { id, outcome: 'failed', message: message(error) })
        }
        continue
      }
    }
    for (const [id, action] of group) {
      try {
        if (Object.keys(action.fields).length > 0) {
          await ports.updateWorktreeMeta(
            `id:${repo.id}${WORKTREE_ID_SEPARATOR}${action.path}`,
            action.fields
          )
        }
        outcomes.set(id, { id, outcome: 'imported' })
      } catch (error) {
        outcomes.set(id, { id, outcome: 'failed', message: message(error) })
      }
    }
  }
}

function mergeThemes(
  current: TerminalCustomTheme[],
  themes: TerminalCustomTheme[]
): TerminalCustomTheme[] {
  const merged = [...current]
  for (const theme of themes) {
    const index = merged.findIndex((existing) => existing.id === theme.id)
    if (index !== -1) {
      merged[index] = theme
    } else if (merged.length < MAX_TERMINAL_CUSTOM_THEMES) {
      merged.push(theme)
    }
  }
  return merged
}

function mergeQuickCommands(
  current: TerminalQuickCommand[],
  commands: TerminalQuickCommand[]
): TerminalQuickCommand[] {
  const merged = [...current]
  for (const command of commands) {
    const index = merged.findIndex((existing) => existing.id === command.id)
    if (index !== -1) {
      merged[index] = command
    } else {
      merged.push(command)
    }
  }
  return merged
}

async function applySettings(
  plan: OrcaImportPlan,
  selected: ReadonlySet<string>,
  ports: OrcaImportApplyPorts,
  outcomes: Outcomes
): Promise<void> {
  const settingEntries: [string, SettingAction][] = selectedActions(plan, selected, isSetting)
  const themeEntries: [string, ThemeAction][] = selectedActions(plan, selected, isTheme)
  const commandEntries: [string, QuickCommandAction][] = selectedActions(
    plan,
    selected,
    isQuickCommand
  )
  // A theme setting naming one of Orca's custom themes brings that theme along.
  for (const [, action] of settingEntries) {
    const value = action.value
    const themeId =
      typeof value === 'string' && value.startsWith(CUSTOM_TERMINAL_THEME_PREFIX)
        ? value.slice(CUSTOM_TERMINAL_THEME_PREFIX.length)
        : null
    const themeAction = themeId === null ? undefined : plan.actions.get(`theme:${themeId}`)
    if (themeAction?.kind === 'theme' && !themeEntries.some(([id]) => id === `theme:${themeId}`)) {
      themeEntries.push([`theme:${themeId}`, themeAction])
    }
  }
  const settings = ports.getSettings()
  const values: Partial<GlobalSettings> = {}
  const written: string[] = []
  for (const [id, action] of settingEntries) {
    Object.assign(values, { [action.key]: action.value })
    written.push(id)
  }
  if (themeEntries.length > 0) {
    values.terminalCustomThemes = mergeThemes(
      settings.terminalCustomThemes ?? [],
      themeEntries.map(([, action]) => action.theme)
    )
    written.push(...themeEntries.map(([id]) => id))
  }
  const commands: TerminalQuickCommand[] = []
  for (const [id, action] of commandEntries) {
    if (action.repoPath === null) {
      commands.push(action.command)
      written.push(id)
      continue
    }
    const repo = podRepoFor(action.repoPath, ports)
    if (!repo) {
      outcomes.set(id, { id, outcome: 'skipped', message: 'Its project is not in Pod.' })
      continue
    }
    commands.push({ ...action.command, scope: { type: 'repo', repoId: repo.id } })
    written.push(id)
  }
  if (commands.length > 0) {
    values.terminalQuickCommands = mergeQuickCommands(
      settings.terminalQuickCommands ?? [],
      commands
    )
  }
  if (written.length === 0) {
    return
  }
  try {
    await ports.writeSettings(values)
    for (const id of written) {
      outcomes.set(id, { id, outcome: 'imported' })
    }
  } catch (error) {
    for (const id of written) {
      outcomes.set(id, { id, outcome: 'failed', message: message(error) })
    }
  }
}

function applyKeybindings(
  entries: [string, KeybindingAction][],
  ports: OrcaImportApplyPorts,
  outcomes: Outcomes
): void {
  const keybindings = ports.keybindings
  if (entries.length === 0 || !keybindings) {
    return
  }
  const path = keybindings.path()
  for (const [id, action] of entries) {
    try {
      writeKeybindingOverride(path, ports.platform, action.actionId, action.bindings)
      outcomes.set(id, { id, outcome: 'imported' })
    } catch (error) {
      outcomes.set(id, { id, outcome: 'failed', message: message(error) })
    }
  }
  keybindings.reload()
}

/** Projects first (worktrees and quick commands need their Pod ids), then one settings write. */
export async function applyOrcaImport(
  plan: OrcaImportPlan,
  itemIds: readonly string[],
  ports: OrcaImportApplyPorts
): Promise<PodOrcaImportItemOutcome[]> {
  const selected = expandSelection(plan, itemIds)
  const outcomes: Outcomes = new Map()
  await applyRepos(selectedActions(plan, selected, isRepo), ports, outcomes)
  await applyWorktrees(selectedActions(plan, selected, isWorktree), ports, outcomes)
  await applySettings(plan, selected, ports, outcomes)
  applyKeybindings(selectedActions(plan, selected, isKeybinding), ports, outcomes)
  const requested = new Set([...itemIds, ...selected])
  return [...requested].map(
    (id) => outcomes.get(id) ?? { id, outcome: 'skipped', message: 'Nothing to import.' }
  )
}
