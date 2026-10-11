// Fork-only (Pod): where each podSettings field sits in a native Settings window.
import type { PodSettingsKey } from './pod-settings-schema'

export type PodSettingsPage = {
  id: 'general' | 'terminal' | 'notifications' | 'accounts' | 'git'
  title: string
  /** A page whose content comes from another RPC namespace (Accounts: `accounts.*`). */
  source?: string
  sections: readonly { title: string; keys: readonly PodSettingsKey[] }[]
}

/** Where each field sits in a native Settings window. */
export const POD_SETTINGS_PAGES: readonly PodSettingsPage[] = [
  {
    id: 'general',
    title: 'General',
    sections: [
      { title: 'Appearance', keys: ['theme', 'uiLanguage', 'showMenuBarIcon'] },
      {
        title: 'Agents',
        keys: [
          'defaultTuiAgent',
          'disabledTuiAgents',
          'agentStatusHooksEnabled',
          'agentWorkspaceTrustEnabled'
        ]
      },
      {
        title: 'Worktrees',
        keys: [
          'workspaceDir',
          'nestWorkspaces',
          'setupScriptLaunchMode',
          'experimentalPodNativeSearch'
        ]
      },
      {
        title: 'Behavior',
        keys: [
          'computerAwakeMode',
          'skipDeleteWorktreeConfirm',
          'skipCloseTerminalWithRunningProcessConfirm'
        ]
      },
      { title: 'Editor', keys: ['editorWordWrap'] }
    ]
  },
  {
    id: 'terminal',
    title: 'Terminal',
    sections: [
      {
        title: 'Font',
        keys: [
          'terminalFontFamily',
          'terminalFontSize',
          'terminalFontWeight',
          'terminalFontWeightBold',
          'terminalLineHeight'
        ]
      },
      {
        title: 'Cursor',
        keys: ['terminalCursorStyle', 'terminalCursorBlink', 'terminalCursorOpacity']
      },
      {
        title: 'Colors',
        keys: [
          'terminalThemeDark',
          'terminalUseSeparateLightTheme',
          'terminalThemeLight',
          'terminalBackgroundOpacity',
          'terminalMinimumContrastRatio',
          'terminalPaddingX',
          'terminalPaddingY'
        ]
      },
      {
        title: 'Keyboard and mouse',
        keys: [
          'terminalMacOptionAsAlt',
          'terminalJISYenToBackslash',
          'terminalMouseHideWhileTyping',
          'terminalFocusFollowsMouse',
          'terminalWordSeparator'
        ]
      },
      {
        title: 'Clipboard',
        keys: [
          'terminalClipboardOnSelect',
          'terminalCopyTrimsGutter',
          'terminalAllowOsc52Clipboard'
        ]
      },
      {
        title: 'Shell',
        keys: [
          'terminalDefaultShell',
          'terminalDefaultShellArgs',
          'terminalScrollbackRows',
          'terminalScopeHistoryByWorktree'
        ]
      },
      {
        title: 'Floating terminal',
        keys: ['floatingTerminalEnabled', 'floatingTerminalCwd']
      }
    ]
  },
  {
    id: 'notifications',
    title: 'Notifications',
    sections: [{ title: 'Notifications', keys: ['notifications'] }]
  },
  { id: 'accounts', title: 'Accounts', source: 'accounts', sections: [] },
  {
    id: 'git',
    title: 'Git',
    sections: [
      {
        title: 'Branches',
        keys: [
          'branchPrefix',
          'branchPrefixCustom',
          'autoRenameBranchFromWork',
          'refreshLocalBaseRefOnWorktreeCreate'
        ]
      },
      { title: 'Performance', keys: ['gitTuning', 'gitTuningFsmonitor'] },
      {
        title: 'Worktrees',
        keys: [
          'alwaysForceDeleteWorktrees',
          'sourceControlCompareAgainstUpstream',
          'showGitIgnoredFiles',
          'followSymlinkedDirectories'
        ]
      }
    ]
  }
]
