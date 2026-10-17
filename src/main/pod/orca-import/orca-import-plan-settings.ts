// Fork-only (Pod): which of Orca's settings, themes and quick commands the import offers.
import { isDeepStrictEqual } from 'node:util'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { PodOrcaImportItem } from '../../../shared/pod-orca-import-types'
import {
  MAX_TERMINAL_CUSTOM_THEMES,
  normalizeTerminalCustomThemes,
  type TerminalCustomTheme
} from '../../../shared/terminal-custom-themes'
import type { TerminalQuickCommand } from '../../../shared/terminal-quick-command-types'
import { repoItemId } from './orca-import-plan-repos'

/**
 * Looks and typing habits only. Never paths, accounts, agents, updates, network, telemetry,
 * experiments or anything sealed with Orca's key; cursor blink stays off in Pod on purpose.
 */
export const ORCA_IMPORT_SETTING_KEYS = [
  'theme',
  'appFontFamily',
  'editorFontFamily',
  'editorWordWrap',
  'editorMinimapEnabled',
  'editorAutoSave',
  'editorAutoSaveDelayMs',
  'leftSidebarAppearanceMode',
  'leftSidebarTintColor',
  'leftSidebarTintOpacity',
  'branchPrefix',
  'branchPrefixCustom',
  'terminalFontSize',
  'terminalFontFamily',
  'terminalFontWeight',
  'terminalFontWeightBold',
  'terminalLineHeight',
  'terminalLigatures',
  'terminalCursorStyle',
  'terminalCursorOpacity',
  'terminalScrollSensitivity',
  'terminalFastScrollSensitivity',
  'terminalThemeDark',
  'terminalThemeLight',
  'terminalUseSeparateLightTheme',
  'terminalDividerColorDark',
  'terminalDividerColorLight',
  'terminalColorOverrides',
  'terminalBackgroundOpacity',
  'terminalMinimumContrastRatio',
  'terminalInactivePaneOpacity',
  'terminalActivePaneOpacity',
  'terminalDividerThicknessPx',
  'terminalPaddingX',
  'terminalPaddingY',
  'terminalMouseHideWhileTyping',
  'terminalWordSeparator',
  'windowBackgroundBlur'
] as const satisfies readonly (keyof GlobalSettings)[]

export type OrcaImportSettingKey = (typeof ORCA_IMPORT_SETTING_KEYS)[number]

// Orca's stock values where Pod's default differs, so an untouched Orca setting is never offered.
const ORCA_STOCK_VALUES: Partial<Record<OrcaImportSettingKey, unknown>> = {
  appFontFamily: 'system-ui'
}

export type SettingAction = { kind: 'setting'; key: OrcaImportSettingKey; value: unknown }
export type ThemeAction = { kind: 'theme'; theme: TerminalCustomTheme }
export type QuickCommandAction = {
  kind: 'quickCommand'
  command: TerminalQuickCommand
  /** Orca's project path for a project-scoped command; Pod's repo id replaces Orca's. */
  repoPath: string | null
}

export type PlannedSettingsItem = {
  item: PodOrcaImportItem
  action: SettingAction | ThemeAction | QuickCommandAction | null
}

const DISPLAY_LIMIT = 80

export function displayValue(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > DISPLAY_LIMIT ? `${text.slice(0, DISPLAY_LIMIT - 1)}…` : text
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {}
}

function compareState(
  orca: unknown,
  pod: unknown,
  podDefault: unknown
): 'present' | 'new' | 'conflict' {
  if (isDeepStrictEqual(orca, pod)) {
    return 'present'
  }
  return pod === undefined || isDeepStrictEqual(pod, podDefault) ? 'new' : 'conflict'
}

export function planSettings(
  orcaSettingsValue: unknown,
  pod: GlobalSettings,
  defaults: GlobalSettings
): PlannedSettingsItem[] {
  const orca = asRecord(orcaSettingsValue)
  const planned: PlannedSettingsItem[] = []
  for (const key of ORCA_IMPORT_SETTING_KEYS) {
    const value = orca[key]
    if (
      value === undefined ||
      isDeepStrictEqual(value, defaults[key]) ||
      (Object.hasOwn(ORCA_STOCK_VALUES, key) && isDeepStrictEqual(value, ORCA_STOCK_VALUES[key]))
    ) {
      continue
    }
    const state = compareState(value, pod[key], defaults[key])
    planned.push({
      item: {
        id: `setting:${key}`,
        kind: 'setting',
        state,
        title: key,
        orcaValue: displayValue(value),
        ...(pod[key] === undefined ? {} : { podValue: displayValue(pod[key]) }),
        selected: state === 'new'
      },
      action: state === 'present' ? null : { kind: 'setting', key, value }
    })
  }
  return planned
}

export function planThemes(orcaSettingsValue: unknown, pod: GlobalSettings): PlannedSettingsItem[] {
  const orcaThemes = normalizeTerminalCustomThemes(asRecord(orcaSettingsValue).terminalCustomThemes)
  const podThemes = new Map((pod.terminalCustomThemes ?? []).map((theme) => [theme.id, theme]))
  let room = MAX_TERMINAL_CUSTOM_THEMES - podThemes.size
  return orcaThemes.map((theme) => {
    const existing = podThemes.get(theme.id)
    const same = existing !== undefined && isDeepStrictEqual(existing.terminal, theme.terminal)
    const full = existing === undefined && room <= 0
    const state = same ? 'present' : existing ? 'conflict' : full ? 'unsupported' : 'new'
    if (state === 'new') {
      room -= 1
    }
    return {
      item: {
        id: `theme:${theme.id}`,
        kind: 'theme',
        state,
        title: theme.name,
        ...(full ? { detail: `Pod keeps at most ${MAX_TERMINAL_CUSTOM_THEMES} themes` } : {}),
        selected: state === 'new'
      },
      action: state === 'new' || state === 'conflict' ? { kind: 'theme', theme } : null
    }
  })
}

function isQuickCommand(value: unknown): value is TerminalQuickCommand {
  const record = asRecord(value)
  return typeof record.id === 'string' && record.id.length > 0 && typeof record.label === 'string'
}

export function planQuickCommands(
  orcaSettingsValue: unknown,
  pod: GlobalSettings,
  orcaRepoPathById: ReadonlyMap<string, string>
): PlannedSettingsItem[] {
  const raw = asRecord(orcaSettingsValue).terminalQuickCommands
  const orcaCommands = Array.isArray(raw) ? raw.filter(isQuickCommand) : []
  const podCommands = new Map(
    (pod.terminalQuickCommands ?? []).map((command) => [command.id, command])
  )
  return orcaCommands.map((command) => {
    const repoId = command.scope?.type === 'repo' ? command.scope.repoId : null
    const repoPath = repoId === null ? null : (orcaRepoPathById.get(repoId) ?? null)
    const existing = podCommands.get(command.id)
    const state =
      repoId !== null && repoPath === null
        ? 'unsupported'
        : existing === undefined
          ? 'new'
          : isDeepStrictEqual({ ...existing, scope: undefined }, { ...command, scope: undefined })
            ? 'present'
            : 'conflict'
    return {
      item: {
        id: `quickCommand:${command.id}`,
        kind: 'quickCommand',
        state,
        title: command.label,
        ...(repoPath ? { detail: repoPath, parentId: repoItemId(repoPath) } : {}),
        selected: state === 'new'
      },
      action:
        state === 'new' || state === 'conflict' ? { kind: 'quickCommand', command, repoPath } : null
    }
  })
}
