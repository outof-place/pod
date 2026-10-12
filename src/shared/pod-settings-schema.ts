// Fork-only (Pod): the settings a native Pod client renders and edits over podSettings.*.
import { z } from 'zod'
import type { TuiAgent } from './tui-agent'
import {
  DESKTOP_TERMINAL_SCROLLBACK_ROWS_MAX,
  DESKTOP_TERMINAL_SCROLLBACK_ROWS_MIN
} from './terminal-scrollback-policy'
import {
  TERMINAL_FONT_WEIGHT_MAX,
  TERMINAL_FONT_WEIGHT_MIN,
  TERMINAL_FONT_WEIGHT_STEP
} from './terminal-fonts'
import { MAX_EDITOR_AUTO_SAVE_DELAY_MS, MIN_EDITOR_AUTO_SAVE_DELAY_MS } from './constants'
import { MAX_TERMINAL_LINE_HEIGHT, MIN_TERMINAL_LINE_HEIGHT } from './terminal-line-height-settings'
import {
  MAX_TERMINAL_CONTRAST_RATIO,
  MIN_TERMINAL_CONTRAST_RATIO
} from './terminal-minimum-contrast-settings'

// Why `satisfies`: an agent Orca adds fails to compile here until a native client can offer it.
const TUI_AGENTS = {
  claude: 'claude',
  'claude-agent-teams': 'claude-agent-teams',
  codebuddy: 'codebuddy',
  openclaude: 'openclaude',
  codex: 'codex',
  autohand: 'autohand',
  opencode: 'opencode',
  opencode2: 'opencode2',
  'mimo-code': 'mimo-code',
  pi: 'pi',
  omp: 'omp',
  qoder: 'qoder',
  'qoder-cn': 'qoder-cn',
  gemini: 'gemini',
  antigravity: 'antigravity',
  aider: 'aider',
  goose: 'goose',
  amp: 'amp',
  kilo: 'kilo',
  kiro: 'kiro',
  crush: 'crush',
  aug: 'aug',
  cline: 'cline',
  codebuff: 'codebuff',
  freebuff: 'freebuff',
  'command-code': 'command-code',
  continue: 'continue',
  cursor: 'cursor',
  droid: 'droid',
  kimi: 'kimi',
  'mistral-vibe': 'mistral-vibe',
  'qwen-code': 'qwen-code',
  rovo: 'rovo',
  hermes: 'hermes',
  openclaw: 'openclaw',
  copilot: 'copilot',
  grok: 'grok',
  devin: 'devin',
  ante: 'ante',
  trae: 'trae',
  muse: 'muse',
  zcode: 'zcode',
  'prime-agent': 'prime-agent',
  dsh: 'dsh',
  jcode: 'jcode'
} as const satisfies { [K in TuiAgent]: K }
const TuiAgentSchema = z.enum(TUI_AGENTS)

const UiLanguageSchema = z.union([
  z.enum(['system', 'en', 'zh', 'ko', 'ja', 'es', 'fr']),
  z.templateLiteral(['plugin:', z.string().min(1)])
])

/** `.meta()` with the row's title and an optional one-line explanation. */
function row<T extends z.ZodType>(schema: T, title: string, description?: string): T {
  return schema.meta(description ? { title, description } : { title })
}

const opacity = z.number().min(0).max(1)

const NotificationsSchema = z
  .object({
    enabled: row(z.boolean(), 'Notifications'),
    agentTaskComplete: row(z.boolean(), 'When an agent finishes'),
    terminalBell: row(z.boolean(), 'On a terminal bell'),
    suppressWhenFocused: row(z.boolean(), 'Not while Pod is in front'),
    customSoundId: row(
      z.enum([
        'system',
        'two-tone',
        'bong',
        'thump',
        'blip',
        'sonar',
        'blop',
        'ding',
        'clack',
        'beep',
        'custom'
      ]),
      'Sound'
    ),
    customSoundPath: row(z.string().max(4096).nullable(), 'Custom sound file'),
    customSoundVolume: row(z.number().min(0).max(100), 'Volume')
  })
  .partial()
  .strict()

/** Every key a native client may read and write, with its row's title. */
export const POD_SETTINGS_FIELDS = {
  theme: row(z.enum(['system', 'dark', 'light']), 'Appearance'),
  uiLanguage: row(UiLanguageSchema, 'Language'),
  showMenuBarIcon: row(z.boolean(), 'Show Pod in the menu bar'),
  defaultTuiAgent: row(
    z.union([TuiAgentSchema, z.literal('blank')]).nullable(),
    'Agent for new agent tabs',
    'None picks the first agent found; blank opens a plain terminal.'
  ),
  disabledTuiAgents: row(z.array(TuiAgentSchema).max(64), 'Hidden agents'),
  agentStatusHooksEnabled: row(
    z.boolean(),
    'Agent status hooks',
    'Pod installs hooks in each agent so it can show when one works, waits or is done.'
  ),
  agentWorkspaceTrustEnabled: row(
    z.boolean(),
    'Trust the folder an agent starts in',
    "Skips the agent's own trust prompt for worktrees Pod starts it in."
  ),
  workspaceDir: row(z.string().min(1).max(4096), 'Folder for new worktrees'),
  nestWorkspaces: row(z.boolean(), 'One folder per repository'),
  setupScriptLaunchMode: row(
    z.enum(['split-vertical', 'split-horizontal', 'new-tab']),
    'Where the setup script runs'
  ),
  experimentalPodNativeSearch: row(z.boolean(), 'Indexed search (experimental)'),
  computerAwakeMode: row(
    z.enum(['off', 'auto', 'on']),
    'Keep the Mac awake',
    'Auto keeps it awake while agents work.'
  ),
  skipDeleteWorktreeConfirm: row(z.boolean(), 'Delete worktrees without asking'),
  skipCloseTerminalWithRunningProcessConfirm: row(
    z.boolean(),
    'Close busy terminals without asking'
  ),
  // PodNative's file editor follows these too (⌥Z there writes the wrap).
  editorWordWrap: row(
    z.boolean(),
    'Wrap long lines',
    'In file editors, instead of scrolling sideways.'
  ),
  editorAutoSave: row(z.boolean(), 'Save files automatically'),
  editorAutoSaveDelayMs: row(
    z.number().int().min(MIN_EDITOR_AUTO_SAVE_DELAY_MS).max(MAX_EDITOR_AUTO_SAVE_DELAY_MS),
    'Autosave delay (ms)',
    'After the last edit.'
  ),
  terminalFontFamily: row(z.string().max(512), 'Font'),
  terminalFontSize: row(z.number().int().min(6).max(72), 'Size'),
  terminalFontWeight: row(
    z
      .number()
      .int()
      .min(TERMINAL_FONT_WEIGHT_MIN)
      .max(TERMINAL_FONT_WEIGHT_MAX)
      .multipleOf(TERMINAL_FONT_WEIGHT_STEP),
    'Weight'
  ),
  terminalFontWeightBold: row(
    z
      .number()
      .int()
      .min(TERMINAL_FONT_WEIGHT_MIN)
      .max(TERMINAL_FONT_WEIGHT_MAX)
      .multipleOf(TERMINAL_FONT_WEIGHT_STEP),
    'Bold weight'
  ),
  terminalLineHeight: row(
    z.number().min(MIN_TERMINAL_LINE_HEIGHT).max(MAX_TERMINAL_LINE_HEIGHT),
    'Line height'
  ),
  terminalCursorStyle: row(z.enum(['bar', 'block', 'underline']), 'Cursor'),
  terminalCursorBlink: row(z.boolean(), 'Blink'),
  terminalCursorOpacity: row(opacity, 'Cursor opacity'),
  terminalThemeDark: row(z.string().min(1).max(256), 'Theme'),
  terminalUseSeparateLightTheme: row(z.boolean(), 'Another theme in light mode'),
  terminalThemeLight: row(z.string().min(1).max(256), 'Light theme'),
  terminalBackgroundOpacity: row(opacity, 'Background opacity'),
  terminalMinimumContrastRatio: row(
    z.number().min(MIN_TERMINAL_CONTRAST_RATIO).max(MAX_TERMINAL_CONTRAST_RATIO),
    'Minimum contrast'
  ),
  terminalPaddingX: row(z.number().int().min(0).max(64), 'Horizontal padding'),
  terminalPaddingY: row(z.number().int().min(0).max(64), 'Vertical padding'),
  terminalMacOptionAsAlt: row(
    z.enum(['auto', 'true', 'false', 'left', 'right']),
    'Option key as Meta',
    'Auto follows the keyboard layout: Option still types @ or € where the layout needs it.'
  ),
  terminalJISYenToBackslash: row(z.boolean(), 'JIS ¥ key types a backslash'),
  terminalMouseHideWhileTyping: row(z.boolean(), 'Hide the pointer while typing'),
  terminalFocusFollowsMouse: row(z.boolean(), 'Focus follows the mouse'),
  terminalWordSeparator: row(z.string().max(256), 'Word separators'),
  terminalClipboardOnSelect: row(z.boolean(), 'Copy on select'),
  terminalCopyTrimsGutter: row(z.boolean(), "Copy without agents' left gutter"),
  terminalAllowOsc52Clipboard: row(z.boolean(), 'Programs may write the clipboard (OSC 52)'),
  terminalDefaultShell: row(z.string().max(4096), 'Shell', 'Empty uses your login shell.'),
  terminalDefaultShellArgs: row(z.array(z.string().max(4096)).max(64), 'Shell arguments'),
  terminalScrollbackRows: row(
    z
      .number()
      .int()
      .min(DESKTOP_TERMINAL_SCROLLBACK_ROWS_MIN)
      .max(DESKTOP_TERMINAL_SCROLLBACK_ROWS_MAX),
    'Scrollback lines'
  ),
  terminalScopeHistoryByWorktree: row(z.boolean(), 'Shell history per worktree'),
  floatingTerminalEnabled: row(
    z.boolean(),
    'Floating terminal',
    'A terminal outside any worktree, over the whole workspace.'
  ),
  // Why the description: settings:set's sanitizer keeps only '', '~' or a folder the main-process
  // picker trusted (floatingTerminalTrustedCwds); any other path is written as ''.
  floatingTerminalCwd: row(
    z.string().max(4096),
    'Floating terminal folder',
    'Empty or ~ is your home folder. Another folder works once picked with Choose… in Classic Settings; a typed path is cleared.'
  ),
  // A JSON object's keys have no order a client keeps; propertyOrder carries the rows'.
  notifications: NotificationsSchema.meta({
    title: 'Notifications',
    propertyOrder: Object.keys(NotificationsSchema.shape)
  }),
  branchPrefix: row(z.enum(['git-username', 'custom', 'none']), 'Branch prefix'),
  branchPrefixCustom: row(z.string().max(256), 'Custom prefix'),
  autoRenameBranchFromWork: row(
    z.boolean(),
    'Name new branches after the work',
    "Renames a worktree's generated branch from its first agent prompt."
  ),
  refreshLocalBaseRefOnWorktreeCreate: row(z.boolean(), 'Update the base branch first'),
  gitTuning: row(
    z.enum(['recommended', 'off']),
    'Git performance config',
    'Repo-local settings that speed up git in large repositories.'
  ),
  gitTuningFsmonitor: row(z.boolean(), 'File system monitor (core.fsmonitor)'),
  alwaysForceDeleteWorktrees: row(z.boolean(), 'Discard changes when deleting a worktree'),
  sourceControlCompareAgainstUpstream: row(z.boolean(), 'Compare against the upstream branch'),
  showGitIgnoredFiles: row(z.boolean(), 'Show ignored files'),
  followSymlinkedDirectories: row(z.boolean(), 'Follow symlinked folders')
}

export type PodSettingsKey = keyof typeof POD_SETTINGS_FIELDS

/** What podSettings.get returns and podSettings.set takes: any subset of the fields. */
export const PodSettingsValuesSchema = z.object(POD_SETTINGS_FIELDS).partial().strict()
export type PodSettingsValues = z.output<typeof PodSettingsValuesSchema>
